# Avatar Switcher

Switch your VRChat avatar from a list using VRChat's built-in OSC (`/avatar/change`).

- `pc/` – the Windows app (Go). It serves a page at `http://localhost:9010`, sends OSC to
  VRChat and can let a phone on the same Wi-Fi connect with a PIN.
- `android/` – the Android app. It opens Avatar Switcher running on your PC.

Every change here is built by `.github/workflows/avatar-switcher.yml`, which publishes
`AvatarSwitcher-Windows.zip` and `AvatarSwitcher.apk` on the repository's Releases page.
