EAPI=8

DESCRIPTION="Experimental ChatGPT Codex desktop compatibility port"
HOMEPAGE="https://github.com/junaga/chatgpt-linux"
SRC_URI="https://github.com/junaga/chatgpt-linux/releases/download/upstream-26.727.40816-port.6/chatgpt.tar.gz -> ${P}.tar.gz"

LICENSE="all-rights-reserved"
SLOT="0"
KEYWORDS="~amd64"
RESTRICT="bindist mirror strip"

RDEPEND="
	app-accessibility/at-spi2-core:2
	app-crypt/libsecret
	dev-libs/expat
	dev-libs/glib:2
	dev-libs/nspr
	dev-libs/nss
	media-libs/alsa-lib
	media-libs/fontconfig
	media-libs/freetype
	media-libs/mesa
	net-print/cups
	sys-apps/dbus
	sys-apps/util-linux
	x11-libs/cairo
	x11-libs/gdk-pixbuf:2
	x11-libs/gtk+:3
	x11-libs/libdrm
	x11-libs/libX11
	x11-libs/libxcb
	x11-libs/libXcomposite
	x11-libs/libXdamage
	x11-libs/libXext
	x11-libs/libXfixes
	x11-libs/libxkbcommon
	x11-libs/libXrandr
	x11-libs/pango
	x11-misc/xdg-utils
"

S="${WORKDIR}"

src_install() {
	cp -a opt "${ED}/" || die
	dobin usr/bin/chatgpt
	domenu usr/share/applications/chatgpt.desktop
	doicon -s 512 usr/share/icons/hicolor/512x512/apps/chatgpt.png
	fperms 4755 /opt/chatgpt/chrome-sandbox
}
