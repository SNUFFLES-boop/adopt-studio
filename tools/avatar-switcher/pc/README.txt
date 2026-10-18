AVATAR SWITCHER 1.1
Switch your VRChat avatar from a list, using VRChat's built-in OSC.
Works with VRChat on PC (desktop or PCVR). It only talks to VRChat and to picture links you paste.

FIRST TIME
1. In VRChat, open the Action Menu > Options > OSC > Enabled.
2. Double-click AvatarSwitcher.exe. A small window opens and your browser shows the switcher.
   Windows may warn that the app is unrecognized because it isn't signed:
   click More info > Run anyway.
3. In Avatar Vault (claude.ai), tap Export backup and save the file.
   In the switcher, click Import from Avatar Vault and pick that file.
   You can also add avatars one at a time with "Add one by ID".
4. Click Switch next to an avatar.

PICTURES
Click "Add picture" on an avatar. Either paste a picture link (on vrchat.com, long-press or
right-click the avatar's picture > Copy image address) or choose an image file.
If a link needs a sign-in to download, save the picture and choose the file instead.

SETTINGS (bottom of the page, on the PC only)
- VRChat address and OSC send/receive ports (defaults 127.0.0.1, 9000, 9001). If you start
  VRChat with --osc=IN:IP:OUT, use the same numbers here.
- Confirm switches: listens for VRChat's reply so it can say "Switched ✓".
- Page port (default 9010).
- Phone access: lets your phone on the same Wi-Fi use the switcher with a 6-digit PIN.
  "New PIN" signs out every phone. Phones can't change settings.

PHONE
Install the Android app (AvatarSwitcher.apk). On the PC, click "Turn on phone access" in the
"Connect your phone" box at the top, then type the address and PIN it shows into the app. Or open that address in your phone's browser.
If Windows asks about the firewall, allow Private networks only.

GOOD TO KNOW
- VRChat only switches to avatars you're allowed to wear (your own uploads, and public
  avatars). If it can't, the switcher says "VRChat didn't switch".
- Keep the black window open while you use it. Close it to stop.
- Your list, pictures and settings are saved next to the exe
  (avatars.json, images folder, settings.json).
