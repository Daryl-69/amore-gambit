'use strict';
/* ══════════════════════════════════════════════════════════════════════
   MusicPlayer – YT IFrame API with mute-unlock trick
   ───────────────────────────────────────────────────────────────────
   HOW PLAYBACK WORKS (Chrome autoplay policy workaround):
     1. Player is initialised with mute:1 in playerVars.
     2. _doPlay() calls ytPlayer.mute() THEN loadVideoById().
        → A muted loadVideoById IS allowed by Chrome on any origin.
     3. _onState() fires state=1 (playing-muted).
        → We immediately call ytPlayer.unMute() + setVolume().
        → This is a synchronous JS API call — 100 % reliable.
   Result: audio always plays.  No postMessage hacks needed.
══════════════════════════════════════════════════════════════════════ */
class MusicPlayer {
  static DEFAULT_API_KEY = 'AIzaSyC063jKgfLUaJyzuxwiGmO_UBYfzC_jz7I';

  constructor() {
    this.ytPlayer   = null;
    this.ytReady    = false;
    this._pendingPlay = null;   // { videoId, seekTo } – queued before ready
    this._unlocked  = false;   // becomes true once we've unMuted at least once

    this.queue      = [];
    this.currentIdx = -1;
    this.isPlaying  = false;
    this.volume     = parseInt(localStorage.getItem('ag_vol') || '75');
    this.apiKey     = localStorage.getItem('ag_yt_key') || MusicPlayer.DEFAULT_API_KEY;

    // Callbacks – wired by app.js
    this.onTrackChange     = null;
    this.onPlayStateChange = null;
    this.onProgress        = null;
    this.onQueueChange     = null;
    this.onEnded           = null;

    this._loadYTAPI();
    this._startProgressTimer();
  }

  /* ════════════════════════════════════════════════════
     YOUTUBE IFRAME API BOOTSTRAP
  ════════════════════════════════════════════════════ */
  _loadYTAPI() {
    // Ensure we have a target element for YT.Player
    this._ensurePlayerEl();

    if (window.YT && window.YT.Player) {
      // API already loaded (e.g. page reload)
      setTimeout(() => this._initPlayer(), 0);
      return;
    }

    // Chain into any existing onYouTubeIframeAPIReady
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      this._initPlayer();
    };

    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  }

  _ensurePlayerEl() {
    const container = document.getElementById('yt-player-container');
    if (!container) { console.error('[Music] #yt-player-container missing'); return; }
    if (!document.getElementById('yt-hidden-player')) {
      const div = document.createElement('div');
      div.id = 'yt-hidden-player';
      container.appendChild(div);
    }
  }

  _initPlayer() {
    if (this.ytPlayer) return;   // already initialised
    const el = document.getElementById('yt-hidden-player');
    if (!el) { console.error('[Music] #yt-hidden-player missing'); return; }

    this.ytPlayer = new YT.Player('yt-hidden-player', {
      height: '150',
      width:  '200',
      playerVars: {
        autoplay:    0,
        mute:        1,   // start muted – Chrome always allows this
        controls:    0,
        disablekb:   1,
        rel:         0,
        fs:          0,
        playsinline: 1,
        enablejsapi: 1,
        origin:      window.location.origin,
      },
      events: {
        onReady:       (e) => this._onReady(e),
        onStateChange: (e) => this._onState(e),
        onError:       (e) => {
          console.warn('[Music] YT error code:', e.data);
          setTimeout(() => this.next(), 800);
        },
      },
    });
  }

  _onReady(e) {
    this.ytReady = true;
    e.target.setVolume(this.volume);
    console.log('[Music] ✓ YT Player ready');

    // Play anything that was requested before the player finished loading
    if (this._pendingPlay) {
      const { videoId, seekTo } = this._pendingPlay;
      this._pendingPlay = null;
      this._doPlay(videoId, seekTo);
    }
  }

  _onState(e) {
    const s = e.data;
    // ── State 1: playing ──────────────────────────────────────────────
    if (s === YT.PlayerState.PLAYING) {
      // Always unmute — we always call ytPlayer.mute() before loadVideoById
      // so every song starts muted and needs to be unmuted here.
      try {
        this.ytPlayer.unMute();
        this.ytPlayer.setVolume(this.volume);
        console.log('[Music] 🔊 unMuted at state=PLAYING');
      } catch (_) {}
      if (!this.isPlaying) {
        this.isPlaying = true;
        this._safeCall('onPlayStateChange', true);
      }
      return;
    }
    // ── State 2: paused ───────────────────────────────────────────────
    if (s === YT.PlayerState.PAUSED) {
      if (this.isPlaying) {
        this.isPlaying = false;
        this._safeCall('onPlayStateChange', false);
      }
      return;
    }
    // ── State 0: ended ────────────────────────────────────────────────
    if (s === YT.PlayerState.ENDED) {
      this.isPlaying = false;
      this._safeCall('onEnded');
      setTimeout(() => this.next(), 300);
    }
  }

  /* ════════════════════════════════════════════════════
     INTERNAL PLAY
  ════════════════════════════════════════════════════ */
  _doPlay(videoId, seekTo = 0) {
    if (!this.ytReady || !this.ytPlayer) {
      this._pendingPlay = { videoId, seekTo };
      return;
    }
    try {
      console.log('[Music] ▶ loadVideoById', videoId, 'seek', seekTo);
      // Mute FIRST → loadVideoById → Chrome allows muted autoplay
      // _onState(PLAYING) will ALWAYS call unMute() + setVolume()
      this.ytPlayer.mute();
      this.ytPlayer.loadVideoById({ videoId, startSeconds: seekTo });
    } catch (err) {
      console.error('[Music] _doPlay error:', err);
    }
  }

  _startProgressTimer() {
    let lastState = -1;
    setInterval(() => {
      if (!this.ytPlayer || !this.ytReady || !this.isPlaying) return;
      try {
        const cur = this.ytPlayer.getCurrentTime() || 0;
        const dur = this.ytPlayer.getDuration()    || 0;
        if (dur > 0) this._safeCall('onProgress', cur, dur);
      } catch (_) {}
    }, 500);
  }

  _safeCall(name, ...args) {
    if (typeof this[name] === 'function') this[name](...args);
  }

  /* ════════════════════════════════════════════════════
     QUEUE MANAGEMENT
  ════════════════════════════════════════════════════ */
  addTrack(track, silent = false) {
    this.queue.push(track);
    const wasEmpty = this.queue.length === 1;
    if (wasEmpty) this.currentIdx = 0;
    if (!silent) {
      this._safeCall('onQueueChange');
      if (wasEmpty) this._safeCall('onTrackChange', track, 0);
    }
  }

  addTracks(tracks, silent = false) {
    tracks.forEach(t => this.queue.push(t));
    if (this.currentIdx === -1 && this.queue.length > 0) this.currentIdx = 0;
    if (!silent) this._safeCall('onQueueChange');
  }

  removeTrack(idx) {
    const wasPlaying = idx === this.currentIdx && this.isPlaying;
    if (wasPlaying) this._stopCurrent();
    this.queue.splice(idx, 1);
    if (this.currentIdx >= this.queue.length) this.currentIdx = Math.max(0, this.queue.length - 1);
    if (this.queue.length === 0) this.currentIdx = -1;
    this._safeCall('onQueueChange');
    if (wasPlaying && this.queue.length > 0) this.play(this.currentIdx);
  }

  setQueue(tracks, currentIdx = 0) {
    this._stopCurrent();
    this.queue      = [...tracks];
    this.currentIdx = tracks.length ? Math.max(0, Math.min(currentIdx, tracks.length - 1)) : -1;
    this._safeCall('onQueueChange');
  }

  clearQueue() {
    this._stopCurrent();
    this.queue      = [];
    this.currentIdx = -1;
    this._safeCall('onQueueChange');
    this._safeCall('onTrackChange', null, -1);
  }

  get currentTrack() { return this.queue[this.currentIdx] ?? null; }

  /* ════════════════════════════════════════════════════
     PUBLIC PLAYBACK API
  ════════════════════════════════════════════════════ */
  play(idx, seekTo = 0) {
    if (idx !== undefined && idx !== null) {
      this.currentIdx = Math.max(0, Math.min(Number(idx), this.queue.length - 1));
    }
    const track = this.currentTrack;
    if (!track?.id) {
      console.warn('[Music] play() – no track at idx', this.currentIdx);
      return;
    }
    // Optimistically mark as playing so UI updates instantly
    this.isPlaying = true;
    this._safeCall('onPlayStateChange', true);
    this._safeCall('onTrackChange', track, this.currentIdx);
    this._safeCall('onQueueChange');
    this._doPlay(track.id, seekTo);
  }

  togglePlay() {
    if (!this.currentTrack) {
      if (this.queue.length > 0) this.play(0);
      return;
    }
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play(this.currentIdx, this.getCurrentTime());
    }
  }

  pause() {
    if (this.ytPlayer && this.ytReady) {
      try { this.ytPlayer.pauseVideo(); } catch (_) {}
    }
    this.isPlaying = false;
    this._safeCall('onPlayStateChange', false);
  }

  resume() {
    if (!this.currentTrack) return;
    if (this.ytPlayer && this.ytReady) {
      try {
        // If already has a loaded video, just play it; otherwise reload
        const state = this.ytPlayer.getPlayerState?.();
        if (state === YT.PlayerState.PAUSED) {
          this.ytPlayer.playVideo();
        } else {
          this._doPlay(this.currentTrack.id, this.getCurrentTime());
        }
      } catch (_) {}
    }
    this.isPlaying = true;
    this._safeCall('onPlayStateChange', true);
  }

  _stopCurrent() {
    if (this.ytPlayer && this.ytReady) {
      try { this.ytPlayer.stopVideo(); } catch (_) {}
    }
    this.isPlaying = false;
  }

  next() {
    if (this.currentIdx < this.queue.length - 1) {
      this.play(this.currentIdx + 1);
    } else {
      this.isPlaying = false;
      this._safeCall('onPlayStateChange', false);
    }
  }

  prev() {
    try {
      if (this.ytPlayer && this.ytReady && this.ytPlayer.getCurrentTime() > 3) {
        this.ytPlayer.seekTo(0, true);
        return;
      }
    } catch (_) {}
    if (this.currentIdx > 0) this.play(this.currentIdx - 1);
  }

  getCurrentTime() {
    try { return this.ytPlayer?.getCurrentTime() || 0; } catch (_) { return 0; }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(100, Math.round(vol)));
    localStorage.setItem('ag_vol', this.volume);
    if (this.ytPlayer && this.ytReady) {
      try { this.ytPlayer.setVolume(this.volume); } catch (_) {}
    }
  }

  seekTo(fraction) {
    if (!this.ytPlayer || !this.ytReady) return;
    try {
      const dur = this.ytPlayer.getDuration() || 0;
      if (dur > 0) this.ytPlayer.seekTo(dur * fraction, true);
    } catch (_) {}
  }

  seekToSeconds(sec) {
    if (!this.ytPlayer || !this.ytReady) return;
    try { this.ytPlayer.seekTo(Math.max(0, sec), true); } catch (_) {}
  }

  setApiKey(key) {
    this.apiKey = key.trim() || MusicPlayer.DEFAULT_API_KEY;
    localStorage.setItem('ag_yt_key', this.apiKey);
  }

  /* ════════════════════════════════════════════════════
     URL / SEARCH HELPERS
  ════════════════════════════════════════════════════ */
  static parseYTId(url) {
    const patterns = [
      /[?&]v=([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /\/embed\/([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) { const m = String(url).match(p); if (m) return m[1]; }
    return null;
  }

  static isYouTubeUrl(url) { return /youtu\.?be|youtube\.com/i.test(url); }
  static isSpotifyUrl(url)  { return /spotify\.com/i.test(url); }

  async searchYouTube(query, maxResults = 10) {
    if (!this.apiKey) throw Object.assign(new Error('No API key'), { code: 'NO_KEY' });
    const url  = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&key=${this.apiKey}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'YouTube API error');
    return (data.items || []).map(item => ({
      id:     item.id.videoId,
      title:  this._decHtml(item.snippet.title),
      artist: item.snippet.channelTitle,
      thumb:  item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      source: 'youtube',
    }));
  }

  async getYTVideoInfo(videoId) {
    const thumb = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    if (!this.apiKey) return { id: videoId, title: 'YouTube Video', artist: 'YouTube', thumb, source: 'youtube' };
    try {
      const res  = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${this.apiKey}`);
      const data = await res.json();
      const item = data.items?.[0];
      if (!item) return { id: videoId, title: 'YouTube Video', artist: 'YouTube', thumb, source: 'youtube' };
      return {
        id:     videoId,
        title:  this._decHtml(item.snippet.title),
        artist: item.snippet.channelTitle,
        thumb:  item.snippet.thumbnails?.medium?.url || thumb,
        source: 'youtube',
      };
    } catch (_) {
      return { id: videoId, title: 'YouTube Video', artist: 'YouTube', thumb, source: 'youtube' };
    }
  }

  async resolveSpotify(spotifyUrl) {
    const res  = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`);
    if (!res.ok) throw new Error('Could not fetch Spotify metadata. Paste a YouTube URL instead.');
    const data   = await res.json();
    const title  = data.title || 'Unknown';
    const thumb  = data.thumbnail_url || '';
    if (!this.apiKey) return { id: null, title, artist: 'Spotify', thumb, source: 'spotify' };
    const results = await this.searchYouTube(title + ' audio', 5);
    if (results.length) { results[0].thumb = results[0].thumb || thumb; return results[0]; }
    return { id: null, title, artist: 'Spotify', thumb, source: 'spotify' };
  }

  async resolveUrl(rawUrl) {
    const url = rawUrl.trim();
    if (!url) return null;
    if (MusicPlayer.isYouTubeUrl(url)) {
      const id = MusicPlayer.parseYTId(url);
      if (!id) throw new Error('Could not extract YouTube video ID from URL');
      return await this.getYTVideoInfo(id);
    }
    if (MusicPlayer.isSpotifyUrl(url)) return await this.resolveSpotify(url);
    const id = MusicPlayer.parseYTId(url);
    if (id) return await this.getYTVideoInfo(id);
    throw new Error('Unsupported URL. Paste a YouTube or Spotify link.');
  }

  _decHtml(h) {
    return h.replace(/&amp;/g,'&').replace(/&quot;/g,'"')
            .replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  }
}
