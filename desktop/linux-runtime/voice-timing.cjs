function installVoiceTimingInstrumentation(app) {
  if (process.env.CODEX_LINUX_VOICE_TIMING !== "1") return;

  app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", (_event, _level, message) => {
      if (message.startsWith("[voice-timing]")) console.log(message);
    });
    contents.on("did-finish-load", () => {
      contents.executeJavaScript(`(() => {
        if (window.__codexVoiceTimingInstalled) return;
        window.__codexVoiceTimingInstalled = true;
        const mark = (event, detail = {}) => console.info("[voice-timing] " + JSON.stringify({ event, at: performance.now(), ...detail }));

        const fetch = window.fetch?.bind(window);
        if (fetch) window.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input?.url;
          const voiceRequest = typeof url === "string" && /realtime|voice/i.test(url);
          if (voiceRequest) mark("voice-request-start", { method: init?.method ?? "GET", url: url.replace(/\?.*/, "") });
          const response = await fetch(input, init);
          if (voiceRequest) mark("voice-request-response", { status: response.status, url: url.replace(/\?.*/, "") });
          return response;
        };

        const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
        if (getUserMedia) navigator.mediaDevices.getUserMedia = async constraints => {
          mark("get-user-media-request", { constraints });
          const stream = await getUserMedia(constraints);
          mark("get-user-media-ready", { tracks: stream.getAudioTracks().map(track => track.getSettings()) });
          return stream;
        };

        const NativePeerConnection = window.RTCPeerConnection;
        if (NativePeerConnection) window.RTCPeerConnection = class extends NativePeerConnection {
          constructor(...args) {
            super(...args);
            mark("peer-connection-created");
            const setLocalDescription = this.setLocalDescription.bind(this);
            this.setLocalDescription = async description => {
              mark("local-description-start", { type: description?.type });
              const value = await setLocalDescription(description);
              mark("local-description-set", { type: description?.type });
              return value;
            };
            const setRemoteDescription = this.setRemoteDescription.bind(this);
            this.setRemoteDescription = async description => {
              mark("remote-description-start", { type: description?.type });
              const value = await setRemoteDescription(description);
              mark("remote-description-set", { type: description?.type });
              return value;
            };
            this.addEventListener("connectionstatechange", () => mark("peer-connection-state", { state: this.connectionState }));
            this.addEventListener("connectionstatechange", () => {
              if (this.connectionState !== "connected" || this.__voiceStatsTimer) return;
              this.__voiceStatsTimer = setInterval(async () => {
                try {
                  const reports = await this.getStats();
                  for (const report of reports.values()) {
                    if (report.type !== "inbound-rtp" || report.kind !== "audio") continue;
                    mark("inbound-audio-stats", {
                      jitter: report.jitter,
                      packetsLost: report.packetsLost,
                      packetsReceived: report.packetsReceived,
                      jitterBufferDelay: report.jitterBufferDelay,
                      jitterBufferEmittedCount: report.jitterBufferEmittedCount,
                    });
                  }
                } catch (error) { mark("webrtc-stats-failed", { name: error?.name }); }
              }, 500);
            });
            this.addEventListener("connectionstatechange", () => {
              if (["closed", "failed", "disconnected"].includes(this.connectionState) && this.__voiceStatsTimer) {
                clearInterval(this.__voiceStatsTimer);
                this.__voiceStatsTimer = undefined;
              }
            });
            this.addEventListener("iceconnectionstatechange", () => mark("ice-connection-state", { state: this.iceConnectionState }));
            this.addEventListener("track", event => mark("remote-track", { kind: event.track?.kind, streams: event.streams?.length ?? 0 }));
            this.addEventListener("datachannel", event => watchChannel(event.channel, "remote"));
          }
          createDataChannel(...args) { const channel = super.createDataChannel(...args); watchChannel(channel, "local"); return channel; }
        };

        const watchChannel = (channel, direction) => {
          mark("data-channel-created", { direction, label: channel?.label });
          channel?.addEventListener("open", () => mark("data-channel-open", { direction, label: channel.label }));
          channel?.addEventListener("close", () => mark("data-channel-close", { direction, label: channel.label }));
          channel?.addEventListener("message", message => {
            let type = "opaque";
            try { type = JSON.parse(String(message.data)).type ?? "untyped-json"; } catch {}
            mark("data-channel-message", { direction, type, size: String(message.data ?? "").length });
          });
        };

        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function(...args) {
          mark("media-play-called", { muted: this.muted, readyState: this.readyState });
          this.addEventListener("loadedmetadata", () => mark("media-loaded-metadata", { readyState: this.readyState }), { once: true });
          this.addEventListener("playing", () => mark("media-playing", { readyState: this.readyState }), { once: true });
          this.addEventListener("waiting", () => mark("media-waiting", { readyState: this.readyState }));
          return play.apply(this, args).then(value => { mark("media-play-resolved", { readyState: this.readyState }); return value; });
        };
        mark("instrumentation-ready");
      })()`, true).catch(error => console.warn("[voice-timing] injection-failed", error));
    });
  });
}

module.exports = { installVoiceTimingInstrumentation };
