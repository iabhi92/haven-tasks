// Server-less device pairing: two devices establish a direct WebRTC data channel and exchange
// encrypted task records over it — no relay server involved at any point, not even as an opaque
// ciphertext passthrough (unlike the optional sync server, docs/ARCHITECTURE.md §5). See
// docs/ARCHITECTURE.md "Server-less WebRTC device pairing" for the full design and honest limits.
//
// WebRTC still needs *some* out-of-band exchange of connection metadata (an SDP offer/answer) to
// establish the peer connection in the first place — that's not a server call, it's the two
// devices' owners manually relaying two short text blobs between the devices themselves (via a
// QR code, or copy/paste). Nothing about that exchange is decryptable content; it's connection
// setup metadata (network candidates, DTLS fingerprints), not task data.
//
// Non-trickle ICE on purpose: waiting for gathering to fully finish before returning the SDP
// means the whole offer/answer is one self-contained blob, exchangeable in a single QR code /
// paste, rather than needing an ongoing signaling channel to trickle candidates one at a time —
// there is no ongoing channel here to trickle them over.

// Public STUN only, never TURN. STUN just helps a device learn its own public-facing address —
// it never sees or relays a single byte of the actual connection's data. TURN would relay data
// through a third party, which is exactly the "server touches it" case this feature exists to
// avoid, so it's deliberately not used: if a direct path can't be found (e.g. symmetric NAT on
// both sides), pairing simply fails rather than silently falling back to relaying through someone
// else's server.
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// SDP requires strict \r\n line endings (RFC 4566), including a terminator after its own last
// line — two real bugs caught by testing, not guessed at:
// 1. Round-tripping text through an HTML <textarea> (copy out of one, paste into another, exactly
//    what this feature's whole UI does) silently normalizes \r\n down to bare \n, which
//    Chromium's SDP parser then rejects outright ("Failed to parse SessionDescription...
//    Invalid SDP line").
// 2. Trimming that pasted value (a reasonable-looking way to strip accidental leading/trailing
//    whitespace from a copy-paste) removes the *required* trailing line terminator along with
//    it, which fails the exact same way — confirmed by testing that trimmed SDP fails and the
//    identical string with one \r\n appended back succeeds.
// Every SDP string that arrives from outside this module (pasted or scanned, never one this
// module generated itself moments ago) needs both fixes before setRemoteDescription will accept
// it: normalize internal line endings, then guarantee exactly one trailing terminator regardless
// of what upstream trimming already did to it.
function normalizeSdpLineEndings(sdp) {
  return sdp.trim().replace(/\r\n|\r|\n/g, "\r\n") + "\r\n";
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    function check() {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", check);
  });
}

// Device A's role: create the connection + data channel, produce an offer to hand to Device B
// by whatever out-of-band means (QR/paste). Resolves once ICE gathering finishes, so the
// returned SDP is the complete, final offer — nothing more to wait for before sharing it.
export async function createOffer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("haven-pair");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);
  return { pc, channel, sdp: pc.localDescription.sdp };
}

// Device B's role: given the offer text Device A produced, create the matching connection and
// an answer to hand back. The data channel arrives via the 'datachannel' event since Device B
// didn't create it — resolved through onChannel rather than returned directly, since it may not
// have fired yet by the time this function itself resolves.
export async function createAnswer(offerSdp, onChannel) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.addEventListener("datachannel", (event) => onChannel(event.channel));
  await pc.setRemoteDescription({ type: "offer", sdp: normalizeSdpLineEndings(offerSdp) });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc);
  return { pc, sdp: pc.localDescription.sdp };
}

// Device A's second step, after Device B's answer comes back by the same out-of-band means.
export async function completeOffer(pc, answerSdp) {
  await pc.setRemoteDescription({ type: "answer", sdp: normalizeSdpLineEndings(answerSdp) });
}

// Resolves once the data channel is actually open and ready to send/receive — distinct from the
// peer connection existing, since ICE connectivity checks and the DTLS handshake still have to
// finish after both descriptions are set.
export function waitForChannelOpen(channel, timeoutMs = 20000) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the connection to open — the two devices may not be able to reach each other directly.")), timeoutMs);
    channel.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    channel.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("Connection failed: " + (e.message || "unknown error"))); }, { once: true });
  });
}
