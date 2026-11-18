---
title: "Installation"
---

## macOS: "Kurlo Not Opened" or "Apple could not verify Kurlo"

Current Kurlo DMGs are not Apple-notarized, so Gatekeeper blocks the first launch. On macOS 15 Sequoia and later the dialog only offers **Done** and **Move to Trash**, and right-click → **Open** no longer works. Pick one of these:

1. **System Settings.** Click **Done**, open *System Settings → Privacy & Security* and scroll down to *Security*. Next to "Kurlo was blocked to protect your Mac" click **Open Anyway**, confirm with your password, then click **Open Anyway** once more. From then on Kurlo opens normally.
2. **Terminal.** Remove the quarantine flag and launch as usual:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Kurlo.app
   ```

On macOS 12–14 you can also right-click `Kurlo.app` in Finder → **Open**, then **Open** again in the dialog.

## macOS: "Kurlo is damaged and can't be opened"

macOS shows this for quarantined apps that are not notarized, most often when the download came through a browser that re-tags files or through a package manager. The app is not broken. Run:

```bash
xattr -dr com.apple.quarantine /Applications/Kurlo.app
```

then open from Finder normally.

## Windows: SmartScreen warning "Windows protected your PC"

Confirm the installer or the portable app came from the official release repository and verify its SHA-256 checksum, then click **More info** → **Run anyway**. Neither the NSIS installer nor the portable `.exe` is currently Authenticode-signed. In-app updater binaries are separately verified by SHA-256 and minisign before installation.

## Linux: AppImage won't launch

The most common cause is a missing executable bit:

```bash
chmod +x kurlo-*.AppImage
./kurlo-*.AppImage
```

If you see `libfuse.so.2: cannot open shared object file`, install FUSE 2:

```bash
sudo apt install libfuse2     # Debian/Ubuntu
sudo dnf install fuse-libs    # Fedora
```

## Linux: GTK / WebKit errors

An error such as `libwebkit2gtk-4.1.so.0: cannot open shared object file` means the GTK 3 or WebKitGTK 4.1 runtime is missing. Install it:

```bash
# Debian / Ubuntu
sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0

# Fedora
sudo dnf install gtk3 webkit2gtk4.1
```

Kurlo 2.2.2 and earlier linked against WebKitGTK 4.0, which Ubuntu 24.04 and later no longer ship, so those versions fail on them with `libwebkit2gtk-4.0.so.37: cannot open shared object file`. Use a newer release.
