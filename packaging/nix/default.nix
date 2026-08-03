{ pkgs ? import <nixpkgs> {} }:

let
  version = "26.727.40816-4";
  payload = pkgs.stdenvNoCC.mkDerivation {
    pname = "chatgpt-linux-payload";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://github.com/junaga/chatgpt-linux/releases/download/upstream-26.727.40816-port.4/chatgpt-linux.tar.gz";
      hash = "sha256-HpNB4GB5iGshpgtsSUW19HLgOCEPUZJkdHBcT0BFGus=";
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
