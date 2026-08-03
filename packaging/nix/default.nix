{ pkgs ? import <nixpkgs> {} }:

let
  version = "26.727.40816-5";
  payload = pkgs.stdenvNoCC.mkDerivation {
    pname = "chatgpt-linux-payload";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://github.com/junaga/chatgpt-linux/releases/download/upstream-26.727.40816-port.5/chatgpt.tar.gz";
      hash = "sha256-cKM7tTbM/hGs4BYDPWY4nJ+289Q+rWREgpqIKwVxpfE=";
    };
    sourceRoot = ".";
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -a opt usr "$out/"
      runHook postInstall
    '';
  };
in pkgs.buildFHSEnv {
  name = "chatgpt";
  targetPkgs = p: with p; [
    payload
    alsa-lib
    at-spi2-core
    cairo
    cups
    dbus
    gtk3
    libdrm
    libxkbcommon
    mesa
    nspr
    nss
    pango
    xorg.libX11
    xorg.libxcb
    xorg.libXcomposite
    xorg.libXdamage
    xorg.libXext
    xorg.libXfixes
    xorg.libXrandr
    xdg-utils
    xz
  ];
  runScript = "/usr/bin/chatgpt --disable-setuid-sandbox";
  meta = {
    description = "Experimental ChatGPT Codex desktop compatibility port";
    homepage = "https://github.com/junaga/chatgpt-linux";
    license = pkgs.lib.licenses.unfree;
    platforms = [ "x86_64-linux" ];
    mainProgram = "chatgpt";
  };
}
