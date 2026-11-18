---
title: "Install the CLI"
---

## Install

On a CI runner or any machine with Node.js 18 or later, use the npm package. It has prebuilt binaries for macOS, Linux and Windows on x64 and arm64, and needs no desktop app:

```bash
npx -y @kurlo/cli run ./my-workspace --env CI
```

or install it once and call `kurlo` directly:

```bash
npm install -g @kurlo/cli
kurlo run ./my-workspace --env CI
```

The desktop app is the CLI as well. If it is installed, `/Applications/Kurlo.app/Contents/MacOS/kurlo run` on macOS, or the `kurlo` executable on Linux and Windows, works the same way.

### `EACCES: permission denied` on `npm install -g`

npm could not write to the folder that holds global packages. It happens with Node from the nodejs.org installer, which puts that folder in `/usr/local`, owned by the system. It is not specific to Kurlo, and any global package fails the same way. Either skip the install and run the CLI with `npx -y @kurlo/cli`, or move global packages into your home folder once:

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
npm install -g @kurlo/cli
```

Node installed with Homebrew, Volta or nvm keeps global packages in your home folder already. Avoid `sudo npm install -g`: it works, but leaves root-owned files that break later installs.
