// Avatar Switcher: a small local web app that switches your VRChat avatar
// through VRChat's built-in OSC ("/avatar/change"). It only talks to VRChat
// on this PC (or the address you set), and to picture links you paste.
package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed index.html
var indexHTML []byte

//go:embed pin.html
var pinHTML []byte

var idRe = regexp.MustCompile(`^avtr_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Avatar struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Creator  string   `json:"creator,omitempty"`
	Platform string   `json:"platform,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	Notes    string   `json:"notes,omitempty"`
	Favorite bool     `json:"favorite,omitempty"`
	AddedAt  string   `json:"addedAt,omitempty"`
	Image    string   `json:"image,omitempty"` // file name in the images folder
}

/* ---------- settings ---------- */

type Settings struct {
	VRChatHost  string `json:"vrchatHost"`  // where VRChat listens for OSC
	SendPort    int    `json:"sendPort"`    // VRChat's OSC input port
	ReceivePort int    `json:"receivePort"` // VRChat's OSC output port (for confirmations)
	Confirm     bool   `json:"confirm"`     // listen for VRChat's reply
	PagePort    int    `json:"pagePort"`
	PhoneAccess bool   `json:"phoneAccess"`
	PIN         string `json:"pin"`
}

func defaultSettings() Settings {
	return Settings{VRChatHost: "127.0.0.1", SendPort: 9000, ReceivePort: 9001, Confirm: true, PagePort: 9010}
}

func newPIN() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	return fmt.Sprintf("%06d", n.Int64())
}

func validPort(p int) bool { return p >= 1024 && p <= 65535 }

/* ---------- storage ---------- */

type app struct {
	dir      string
	mu       sync.Mutex
	avatars  []Avatar
	settings Settings
	vrc      *vrchat
	web      *http.Server
	webErr   string
	allowed  map[string]bool
	lanURLs  []string
}

func (a *app) path(name string) string { return filepath.Join(a.dir, name) }

func writeFileAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *app) load() {
	if b, err := os.ReadFile(a.path("avatars.json")); err == nil {
		if err := json.Unmarshal(b, &a.avatars); err != nil {
			fmt.Println("Couldn't read avatars.json:", err)
		}
	}
	a.settings = defaultSettings()
	if b, err := os.ReadFile(a.path("settings.json")); err == nil {
		_ = json.Unmarshal(b, &a.settings)
	}
	if a.settings.PIN == "" {
		a.settings.PIN = newPIN()
	}
}

func (a *app) saveAvatarsLocked() error {
	b, _ := json.MarshalIndent(a.avatars, "", "  ")
	return writeFileAtomic(a.path("avatars.json"), b)
}

func (a *app) saveSettingsLocked() error {
	b, _ := json.MarshalIndent(a.settings, "", "  ")
	return writeFileAtomic(a.path("settings.json"), b)
}

func (a *app) list() []Avatar {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := append([]Avatar(nil), a.avatars...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Favorite != out[j].Favorite {
			return out[i].Favorite
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func (a *app) merge(in []Avatar) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	have := map[string]bool{}
	for _, x := range a.avatars {
		have[strings.ToLower(x.ID)] = true
	}
	added := 0
	for _, x := range in {
		x.ID = strings.TrimSpace(x.ID)
		if !idRe.MatchString(x.ID) || have[strings.ToLower(x.ID)] {
			continue
		}
		if strings.TrimSpace(x.Name) == "" {
			x.Name = "Untitled avatar"
		}
		if x.AddedAt == "" {
			x.AddedAt = time.Now().UTC().Format(time.RFC3339)
		}
		x.Image = ""
		have[strings.ToLower(x.ID)] = true
		a.avatars = append(a.avatars, x)
		added++
	}
	if added == 0 {
		return 0, nil
	}
	return added, a.saveAvatarsLocked()
}

func (a *app) remove(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := a.avatars[:0]
	for _, x := range a.avatars {
		if strings.EqualFold(x.ID, id) {
			if x.Image != "" {
				_ = os.Remove(filepath.Join(a.dir, "images", x.Image))
			}
			continue
		}
		out = append(out, x)
	}
	a.avatars = out
	return a.saveAvatarsLocked()
}

func (a *app) setImage(id, file string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := range a.avatars {
		if strings.EqualFold(a.avatars[i].ID, id) {
			if old := a.avatars[i].Image; old != "" && old != file {
				_ = os.Remove(filepath.Join(a.dir, "images", old))
			}
			a.avatars[i].Image = file
			return a.saveAvatarsLocked()
		}
	}
	return errors.New("no such avatar")
}

/* ---------- pictures ---------- */

var imgExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}

func sniffImage(b []byte) (string, bool) {
	ct := http.DetectContentType(b)
	ext, ok := imgExt[ct]
	return ext, ok
}

func (a *app) storeImage(id string, data []byte) error {
	ext, ok := sniffImage(data)
	if !ok {
		return errors.New("not a PNG, JPG, WebP or GIF picture")
	}
	if err := os.MkdirAll(a.path("images"), 0o755); err != nil {
		return err
	}
	name := strings.ToLower(id) + "-" + strconv.FormatInt(time.Now().Unix(), 36) + ext
	if err := os.WriteFile(filepath.Join(a.dir, "images", name), data, 0o644); err != nil {
		return err
	}
	return a.setImage(id, name)
}

// fetchImage downloads a picture from a public link. Local and private
// network addresses are refused, so a link can't be used to probe your network.
func fetchImage(link string) ([]byte, error) {
	u, err := http.NewRequest(http.MethodGet, link, nil)
	if err != nil || (u.URL.Scheme != "https" && u.URL.Scheme != "http") {
		return nil, errors.New("that isn't a web link")
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	tr := &http.Transport{
		Proxy: nil, // connect directly so the address check above can't be bypassed
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, _ := net.SplitHostPort(addr)
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(ips) == 0 {
				return nil, errors.New("can't find that website")
			}
			ip := ips[0].IP
			if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
				return nil, errors.New("local addresses aren't allowed")
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		},
	}
	client := &http.Client{Timeout: 20 * time.Second, Transport: tr}
	u.Header.Set("User-Agent", "AvatarSwitcher/1.1")
	res, err := client.Do(u)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == 401 || res.StatusCode == 403 {
		return nil, errors.New("that picture needs a sign-in to download. Save the picture and choose the file instead")
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("the website answered %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 10<<20+1))
	if err != nil {
		return nil, err
	}
	if len(b) > 10<<20 {
		return nil, errors.New("that picture is over 10 MB")
	}
	return b, nil
}

/* ---------- OSC ---------- */

func oscPad(b []byte) []byte {
	b = append(b, 0)
	for len(b)%4 != 0 {
		b = append(b, 0)
	}
	return b
}

func oscString(addr, value string) []byte {
	msg := oscPad([]byte(addr))
	msg = append(msg, oscPad([]byte(",s"))...)
	return append(msg, oscPad([]byte(value))...)
}

func readOSCString(b []byte) (string, []byte, bool) {
	i := 0
	for i < len(b) && b[i] != 0 {
		i++
	}
	if i >= len(b) {
		return "", nil, false
	}
	n := (i + 4) &^ 3
	if n > len(b) {
		n = len(b)
	}
	return string(b[:i]), b[n:], true
}

func parseAvatarChange(pkt []byte) (string, bool) {
	addr, rest, ok := readOSCString(pkt)
	if !ok || addr != "/avatar/change" {
		return "", false
	}
	tags, rest, ok := readOSCString(rest)
	if !ok || !strings.HasPrefix(tags, ",s") {
		return "", false
	}
	id, _, ok := readOSCString(rest)
	return id, ok
}

type vrchat struct {
	mu        sync.Mutex
	sendAddr  string
	current   string
	listening bool
	listenErr string
	conn      net.PacketConn
	waiters   []chan string
}

func (v *vrchat) send(id string) error {
	v.mu.Lock()
	addr := v.sendAddr
	v.mu.Unlock()
	conn, err := net.Dial("udp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write(oscString("/avatar/change", id))
	return err
}

// configure points sending at host:sendPort and (re)starts listening on receivePort.
func (v *vrchat) configure(host string, sendPort, receivePort int, confirm bool) {
	v.mu.Lock()
	v.sendAddr = net.JoinHostPort(host, strconv.Itoa(sendPort))
	if v.conn != nil {
		v.conn.Close()
		v.conn = nil
	}
	v.listening, v.listenErr = false, ""
	v.mu.Unlock()
	if !confirm {
		return
	}
	listenHost := "127.0.0.1"
	if ip := net.ParseIP(host); ip != nil && !ip.IsLoopback() {
		listenHost = "0.0.0.0"
	}
	pc, err := net.ListenPacket("udp", net.JoinHostPort(listenHost, strconv.Itoa(receivePort)))
	v.mu.Lock()
	defer v.mu.Unlock()
	if err != nil {
		v.listenErr = fmt.Sprintf("Port %d is in use by another app, so switches can't be confirmed. Switching still works.", receivePort)
		return
	}
	v.conn, v.listening = pc, true
	go v.read(pc)
}

func (v *vrchat) read(pc net.PacketConn) {
	buf := make([]byte, 4096)
	for {
		n, _, err := pc.ReadFrom(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if id, ok := parseAvatarChange(buf[:n]); ok {
			v.mu.Lock()
			v.current = id
			for _, w := range v.waiters {
				select {
				case w <- id:
				default:
				}
			}
			v.waiters = nil
			v.mu.Unlock()
		}
	}
}

func (v *vrchat) switchTo(id string, wait time.Duration) (*bool, error) {
	v.mu.Lock()
	listening := v.listening
	ch := make(chan string, 4)
	if listening {
		v.waiters = append(v.waiters, ch)
	}
	v.mu.Unlock()
	if err := v.send(id); err != nil {
		return nil, err
	}
	if !listening {
		return nil, nil
	}
	deadline := time.After(wait)
	for {
		select {
		case got := <-ch:
			if strings.EqualFold(got, id) {
				t := true
				return &t, nil
			}
			v.mu.Lock()
			v.waiters = append(v.waiters, ch)
			v.mu.Unlock()
		case <-deadline:
			f := false
			return &f, nil
		}
	}
}

/* ---------- web server ---------- */

func isLocalHost(host string) bool { return host == "localhost" || host == "127.0.0.1" }

func hostOnly(h string) string {
	if x, _, err := net.SplitHostPort(h); err == nil {
		h = x
	}
	return strings.ToLower(strings.Trim(h, "[]"))
}

// guard blocks requests from other websites (a page you visit can't make this
// app switch or delete avatars), unexpected host names, and phones that haven't
// entered the PIN.
func (a *app) guard(w http.ResponseWriter, r *http.Request) bool {
	host := hostOnly(r.Host)
	a.mu.Lock()
	allowed, pin := a.allowed[host], a.settings.PIN
	a.mu.Unlock()
	if !allowed {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	if r.Method != http.MethodGet && r.Header.Get("X-Avatar-Switcher") != "1" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	if !isLocalHost(host) {
		c, err := r.Cookie("as_pin")
		if err != nil || c.Value != pin {
			if r.URL.Path == "/" {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.Write(pinHTML)
			} else {
				http.Error(w, "enter the PIN", http.StatusUnauthorized)
			}
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func decode(w http.ResponseWriter, r *http.Request, max int64, v any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, max)).Decode(v); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return false
	}
	return true
}

func (a *app) state() map[string]any {
	a.vrc.mu.Lock()
	cur, listening, listenErr := a.vrc.current, a.vrc.listening, a.vrc.listenErr
	a.vrc.mu.Unlock()
	a.mu.Lock()
	st, lan, webErr := a.settings, append([]string(nil), a.lanURLs...), a.webErr
	a.mu.Unlock()
	return map[string]any{"avatars": a.list(), "current": cur, "listening": listening, "listenError": listenErr,
		"settings": st, "lan": lan, "webError": webErr}
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	page := func(body []byte) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if !a.guard(w, r) {
				return
			}
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'")
			w.Write(body)
		}
	}
	mux.HandleFunc("/", page(indexHTML))
	mux.HandleFunc("/pin", func(w http.ResponseWriter, r *http.Request) {
		host := hostOnly(r.Host)
		a.mu.Lock()
		allowed, pin := a.allowed[host], a.settings.PIN
		a.mu.Unlock()
		if !allowed || r.Method != http.MethodPost || r.Header.Get("X-Avatar-Switcher") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var body struct{ PIN string }
		if !decode(w, r, 1<<10, &body) {
			return
		}
		time.Sleep(400 * time.Millisecond) // slows down guessing
		if strings.TrimSpace(body.PIN) != pin {
			http.Error(w, "wrong PIN", http.StatusUnauthorized)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "as_pin", Value: pin, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 365 * 24 * 3600})
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if a.guard(w, r) {
			writeJSON(w, a.state())
		}
	})
	mux.HandleFunc("/img/", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		name := filepath.Base(r.URL.Path)
		if name == "." || name == "/" || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "max-age=31536000, immutable")
		http.ServeFile(w, r, filepath.Join(a.dir, "images", name))
	})
	mux.HandleFunc("/api/import", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		var raw json.RawMessage
		if !decode(w, r, 8<<20, &raw) {
			return
		}
		var list []Avatar
		var wrapped struct {
			Avatars []Avatar `json:"avatars"`
		}
		if json.Unmarshal(raw, &wrapped) == nil && wrapped.Avatars != nil {
			list = wrapped.Avatars
		} else if err := json.Unmarshal(raw, &list); err != nil {
			http.Error(w, "not an Avatar Vault backup", http.StatusBadRequest)
			return
		}
		n, err := a.merge(list)
		if err != nil {
			http.Error(w, "couldn't save", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]int{"added": n})
	})
	mux.HandleFunc("/api/add", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		var x Avatar
		if !decode(w, r, 64<<10, &x) {
			return
		}
		if !idRe.MatchString(strings.TrimSpace(x.ID)) {
			http.Error(w, "bad avatar id", http.StatusBadRequest)
			return
		}
		n, err := a.merge([]Avatar{x})
		if err != nil {
			http.Error(w, "couldn't save", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]int{"added": n})
	})
	mux.HandleFunc("/api/delete", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		var body struct{ ID string }
		if !decode(w, r, 4<<10, &body) {
			return
		}
		if err := a.remove(body.ID); err != nil {
			http.Error(w, "couldn't save", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/image-url", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		var body struct{ ID, URL string }
		if !decode(w, r, 8<<10, &body) {
			return
		}
		data, err := fetchImage(strings.TrimSpace(body.URL))
		if err == nil {
			err = a.storeImage(body.ID, data)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/image-file", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "use POST", http.StatusMethodNotAllowed)
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 10<<20))
		if err == nil {
			err = a.storeImage(r.URL.Query().Get("id"), data)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/image-remove", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		var body struct{ ID string }
		if !decode(w, r, 4<<10, &body) {
			return
		}
		_ = a.setImage(body.ID, "")
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/switch", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		var body struct{ ID string }
		if !decode(w, r, 4<<10, &body) {
			return
		}
		if !idRe.MatchString(body.ID) {
			http.Error(w, "bad avatar id", http.StatusBadRequest)
			return
		}
		confirmed, err := a.vrc.switchTo(body.ID, 6*time.Second)
		if err != nil {
			http.Error(w, "couldn't reach VRChat", http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]any{"sent": true, "confirmed": confirmed})
	})
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		if !a.guard(w, r) {
			return
		}
		if !isLocalHost(hostOnly(r.Host)) {
			http.Error(w, "settings can only be changed on the PC", http.StatusForbidden)
			return
		}
		var in struct {
			Settings
			NewPIN bool `json:"newPin"`
		}
		if !decode(w, r, 4<<10, &in) {
			return
		}
		host := strings.TrimSpace(in.VRChatHost)
		if host == "" || (net.ParseIP(host) == nil && host != "localhost") {
			http.Error(w, "VRChat address must be an IP address like 127.0.0.1", http.StatusBadRequest)
			return
		}
		if !validPort(in.SendPort) || !validPort(in.ReceivePort) || !validPort(in.PagePort) || in.SendPort == in.ReceivePort {
			http.Error(w, "ports must be between 1024 and 65535, and the two OSC ports must differ", http.StatusBadRequest)
			return
		}
		a.mu.Lock()
		old := a.settings
		a.settings.VRChatHost, a.settings.SendPort, a.settings.ReceivePort, a.settings.Confirm = host, in.SendPort, in.ReceivePort, in.Confirm
		a.settings.PagePort, a.settings.PhoneAccess = in.PagePort, in.PhoneAccess
		if in.NewPIN {
			a.settings.PIN = newPIN()
		}
		ns := a.settings
		err := a.saveSettingsLocked()
		a.mu.Unlock()
		if err != nil {
			http.Error(w, "couldn't save settings", http.StatusInternalServerError)
			return
		}
		if old.VRChatHost != ns.VRChatHost || old.SendPort != ns.SendPort || old.ReceivePort != ns.ReceivePort || old.Confirm != ns.Confirm {
			a.vrc.configure(ns.VRChatHost, ns.SendPort, ns.ReceivePort, ns.Confirm)
		}
		restart := old.PagePort != ns.PagePort || old.PhoneAccess != ns.PhoneAccess
		writeJSON(w, map[string]any{"ok": true, "restartPage": restart, "url": fmt.Sprintf("http://localhost:%d", ns.PagePort)})
		if restart {
			go func() { time.Sleep(300 * time.Millisecond); a.restartWeb() }()
		}
	})
	return mux
}

// tailscaleNet is the address range VPNs like Tailscale use (100.64.0.0/10).
var _, tailscaleNet, _ = net.ParseCIDR("100.64.0.0/10")

func localIPs() []string {
	var out []string
	addrs, _ := net.InterfaceAddrs()
	for _, ad := range addrs {
		if ipn, ok := ad.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil && (ipn.IP.IsPrivate() || tailscaleNet.Contains(ipn.IP)) {
			out = append(out, ipn.IP.String())
		}
	}
	return out
}

// startWeb (re)binds the page using the current port and phone-access setting.
func (a *app) startWeb() error {
	a.mu.Lock()
	st := a.settings
	a.allowed = map[string]bool{"localhost": true, "127.0.0.1": true}
	a.lanURLs = nil
	bind := fmt.Sprintf("127.0.0.1:%d", st.PagePort)
	if st.PhoneAccess {
		bind = fmt.Sprintf("0.0.0.0:%d", st.PagePort)
		for _, ip := range localIPs() {
			a.allowed[ip] = true
			a.lanURLs = append(a.lanURLs, fmt.Sprintf("http://%s:%d", ip, st.PagePort))
		}
	}
	a.mu.Unlock()
	ln, err := net.Listen("tcp", bind)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second}
	a.mu.Lock()
	a.web, a.webErr = srv, ""
	a.mu.Unlock()
	go srv.Serve(ln)
	a.printInfo()
	return nil
}

func (a *app) restartWeb() {
	a.mu.Lock()
	old := a.web
	a.mu.Unlock()
	if old != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = old.Shutdown(ctx)
		cancel()
	}
	if err := a.startWeb(); err != nil {
		fmt.Println("Couldn't open the page on the new port:", err)
		a.mu.Lock()
		a.settings.PagePort = 9010
		a.webErr = err.Error()
		_ = a.saveSettingsLocked()
		a.mu.Unlock()
		_ = a.startWeb()
	}
}

func (a *app) printInfo() {
	a.mu.Lock()
	st, lan := a.settings, a.lanURLs
	a.mu.Unlock()
	fmt.Println()
	fmt.Println("Avatar Switcher is running.")
	fmt.Printf("  Open: http://localhost:%d\n", st.PagePort)
	if st.PhoneAccess {
		for _, u := range lan {
			fmt.Println("  On your phone (same Wi-Fi):", u)
		}
		fmt.Println("  Phone PIN:", st.PIN)
	}
	fmt.Printf("  Sending OSC to %s:%d\n", st.VRChatHost, st.SendPort)
	fmt.Println("  In VRChat, turn on OSC: Action Menu > Options > OSC > Enabled.")
	fmt.Println("Keep this window open while you use it. Close it to stop.")
}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		_ = exec.Command("open", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}

func main() {
	lan := flag.Bool("lan", false, "turn on phone access")
	noBrowser := flag.Bool("no-browser", false, "don't open the browser on start")
	flag.Parse()

	exe, _ := os.Executable()
	a := &app{dir: filepath.Dir(exe), vrc: &vrchat{}}
	a.load()
	if *lan {
		a.settings.PhoneAccess = true
	}
	a.mu.Lock()
	_ = a.saveSettingsLocked()
	a.mu.Unlock()
	a.vrc.configure(a.settings.VRChatHost, a.settings.SendPort, a.settings.ReceivePort, a.settings.Confirm)
	if err := a.startWeb(); err != nil {
		fmt.Printf("Couldn't start on port %d: %v\nIs Avatar Switcher already running?\n\nPress Enter to close.", a.settings.PagePort, err)
		fmt.Scanln()
		os.Exit(1)
	}
	if !*noBrowser {
		go openBrowser(fmt.Sprintf("http://localhost:%d", a.settings.PagePort))
	}
	select {}
}
