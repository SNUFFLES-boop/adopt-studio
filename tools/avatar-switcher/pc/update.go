package main

// Updater: checks this project's GitHub releases for a newer Avatar Switcher
// and, when asked, replaces the running exe with the new one and restarts.

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// version is set at build time with -ldflags "-X main.version=1.1.N".
var version = "dev"

// releasesAPI is a var (not a const) so a test build can point it elsewhere with -ldflags -X.
var releasesAPI = "https://api.github.com/repos/SNUFFLES-boop/adopt-studio/releases?per_page=20"

const (
	tagPrefix = "avatar-switcher-v"
	zipAsset  = "AvatarSwitcher-Windows.zip"
)

type releaseInfo struct {
	Version string `json:"version"`
	Notes   string `json:"notes"`
	URL     string `json:"url"`
	zipURL  string
	digest  string
}

type updater struct {
	mu        sync.Mutex
	latest    *releaseInfo
	checkedAt time.Time
	checkErr  string
	updating  bool
	exePath   string // where the app file lives; set before the swap renames it
}

// compareVersions returns >0 when a is newer than b ("1.1.10" > "1.1.9").
func compareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

func (u *updater) check() {
	client := &http.Client{Timeout: 20 * time.Second}
	req, _ := http.NewRequest(http.MethodGet, releasesAPI, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "AvatarSwitcher/"+version)
	res, err := client.Do(req)
	if err != nil {
		u.setErr("Couldn't check for updates (no internet?).")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		u.setErr(fmt.Sprintf("Couldn't check for updates (GitHub answered %d).", res.StatusCode))
		return
	}
	var rels []struct {
		Tag        string `json:"tag_name"`
		Body       string `json:"body"`
		HTMLURL    string `json:"html_url"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name   string `json:"name"`
			URL    string `json:"browser_download_url"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&rels); err != nil {
		u.setErr("Couldn't read the update list.")
		return
	}
	var best *releaseInfo
	for _, r := range rels {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, tagPrefix) {
			continue
		}
		v := strings.TrimPrefix(r.Tag, tagPrefix)
		if best != nil && compareVersions(v, best.Version) <= 0 {
			continue
		}
		for _, a := range r.Assets {
			if a.Name == zipAsset {
				best = &releaseInfo{Version: v, Notes: r.Body, URL: r.HTMLURL, zipURL: a.URL, digest: strings.TrimPrefix(a.Digest, "sha256:")}
			}
		}
	}
	u.mu.Lock()
	u.latest, u.checkedAt, u.checkErr = best, time.Now(), ""
	u.mu.Unlock()
}

func (u *updater) setErr(msg string) {
	u.mu.Lock()
	u.checkErr, u.checkedAt = msg, time.Now()
	u.mu.Unlock()
}

// status reports what the page shows: the running version and any newer one.
func (u *updater) status() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := map[string]any{"version": version, "updating": u.updating, "checkError": u.checkErr}
	if !u.checkedAt.IsZero() {
		out["checkedAt"] = u.checkedAt.UTC().Format(time.RFC3339)
	}
	if u.latest != nil && version != "dev" && compareVersions(u.latest.Version, version) > 0 {
		out["available"] = u.latest
	}
	return out
}

func (u *updater) loop(enabled func() bool) {
	for {
		if enabled() {
			u.check()
		}
		time.Sleep(6 * time.Hour)
	}
}

// install downloads the new zip, swaps the exe and starts it. The caller exits afterwards.
func (u *updater) install() error {
	u.mu.Lock()
	rel := u.latest
	if u.updating {
		u.mu.Unlock()
		return errors.New("an update is already running")
	}
	if rel == nil || compareVersions(rel.Version, version) <= 0 {
		u.mu.Unlock()
		return errors.New("you already have the newest version")
	}
	u.updating = true
	u.mu.Unlock()
	fail := func(err error) error {
		u.mu.Lock()
		u.updating = false
		u.mu.Unlock()
		return err
	}

	client := &http.Client{Timeout: 5 * time.Minute}
	res, err := client.Get(rel.zipURL)
	if err != nil {
		return fail(errors.New("couldn't download the update"))
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fail(fmt.Errorf("couldn't download the update (%d)", res.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 100<<20))
	if err != nil {
		return fail(errors.New("the download was interrupted"))
	}
	if rel.digest != "" {
		sum := sha256.Sum256(data)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), rel.digest) {
			return fail(errors.New("the download was damaged (checksum didn't match)"))
		}
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fail(errors.New("the download isn't a valid zip"))
	}
	var newExe []byte
	for _, f := range zr.File {
		if strings.EqualFold(filepath.Base(f.Name), "AvatarSwitcher.exe") {
			rc, err := f.Open()
			if err != nil {
				return fail(err)
			}
			newExe, err = io.ReadAll(io.LimitReader(rc, 100<<20))
			rc.Close()
			if err != nil {
				return fail(err)
			}
		}
	}
	if len(newExe) < 1<<20 || (runtime.GOOS == "windows" && !bytes.HasPrefix(newExe, []byte("MZ"))) {
		return fail(errors.New("the update doesn't contain the app"))
	}

	exe, err := os.Executable()
	if err != nil {
		return fail(err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	u.mu.Lock()
	u.exePath = exe
	u.mu.Unlock()
	tmp, old := exe+".new", exe+".old"
	if err := os.WriteFile(tmp, newExe, 0o755); err != nil {
		return fail(errors.New("couldn't save the update next to the app (is the folder read-only?)"))
	}
	_ = os.Remove(old)
	// Windows lets a running exe be renamed, but not overwritten.
	if err := os.Rename(exe, old); err != nil {
		os.Remove(tmp)
		return fail(errors.New("couldn't replace the app file"))
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Rename(old, exe)
		return fail(errors.New("couldn't replace the app file"))
	}
	return nil
}

// restart starts the new exe at path with the same arguments, telling it not to open another browser tab.
func restart(exe string) error {
	args := []string{"-no-browser", "-after-update"}
	for _, a := range os.Args[1:] {
		if a != "-no-browser" && a != "-after-update" {
			args = append(args, a)
		}
	}
	cmd := exec.Command(exe, args...)
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", append([]string{"/c", "start", "Avatar Switcher", exe}, args...)...)
	}
	cmd.Dir = filepath.Dir(exe)
	return cmd.Start()
}

// cleanupOld removes the previous exe left behind by an update.
func cleanupOld() {
	if exe, err := os.Executable(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}
