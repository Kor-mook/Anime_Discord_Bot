import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  getVoiceConnections,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import type { ConversationReply, TurnEnvelope, VoiceConsentCheck, VoiceProfile } from '@anime/contracts';
import { VoiceServiceClient, type VoiceRecognitionLanguage } from './voice-service-client.js';
const VAD_START_CONFIRMATION_MS = 180;
// Keep short but clear address phrases (for example, "Hello Seline") usable.
// Start confirmation still filters brief keyboard noise before this limit applies.
const VAD_MINIMUM_UTTERANCE_MS = 300;
const VAD_SHORT_UTTERANCE_MS = 700;
// A natural speaker often pauses between clauses or sentences for 300-800 ms.
// Do not turn that pause into a full AI reply; wait for a real turn hand-off.
const VAD_SHORT_SILENCE_MS = 750;
const VAD_LONG_SILENCE_MS = 1_050;
const VAD_MAX_UTTERANCE_MS = 12_000;
const VAD_CAPTURE_DEADLINE_MS = 10_000;
const VAD_SPEAKING_END_GRACE_MS = 1_150;
const VAD_INITIAL_NOISE_FLOOR = 120;
const VAD_MIN_RMS = 450;
const VOICE_INPUT_MAX_CHARS = 500;
// Discord may report a speaking event for keyboard noise, game audio, or an
// open microphone. Keep the turn gate conservative so that those events do
// not become unsolicited assistant replies.
// Whisper's segment score is intentionally conservative for brief, otherwise
// clear utterances. VAD has already removed silence, so retain those turns
// while still rejecting obvious noise and hallucinations.
const VOICE_MIN_STT_CONFIDENCE = 0.25;
const VOICE_TTS_STREAM_IDLE_TIMEOUT_MS = 5_000;
const PCM_KEEP_ALIVE_INTERVAL_MS = 20;
// 20 ms of signed 16-bit, 48 kHz, stereo silence. Once Discord has started
// playing a raw PCM resource, a brief gap between separately generated TTS
// sentences can otherwise make the AudioPlayer transition to Idle. The player
// then stops reading the PassThrough and the next real PCM write deadlocks.
const PCM_KEEP_ALIVE_SILENCE = Buffer.alloc(48_000 * 2 * 2 * PCM_KEEP_ALIVE_INTERVAL_MS / 1_000);
const VOICE_PLAYBACK_ECHO_WINDOW_MS = 20_000;
const VOICE_CONSENT_NOTICE_COOLDOWN_MS = 5 * 60_000;
// A denied user cannot enter any audio path. Cache that result briefly so an open
// microphone does not repeatedly query the website or reserve voice-processing work.
const VOICE_CONSENT_DENIAL_CACHE_MS = 60_000;
const VOICE_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
const VOICE_RECONNECT_READY_TIMEOUT_MS = 15_000;

export type ConversationApi = {
  createTurn(input: TurnEnvelope): Promise<ConversationReply>;
  streamTurn?(input: TurnEnvelope): AsyncIterable<ConversationReply>;
};

export type StartVoiceSessionInput = {
  channel: VoiceBasedChannel;
  botUserId: string;
  recognitionLanguage?: VoiceRecognitionLanguage;
  greeting?: { text: string; voiceProfile: VoiceProfile };
  idleNudge?: { text: string; voiceProfile: VoiceProfile; delayMs?: number; maxCount?: number };
  idleDisconnect?: { text: string; voiceProfile: VoiceProfile; delayMs?: number };
};

export type VoiceTextMessageInput = {
  guildId: string;
  channelId: string;
  userId: string;
  text: string;
};

export type VoiceSessionStatus = {
  guildId: string;
  channelId: string;
  startedAt: string;
};

export type VoiceProcessingMetric = {
  guildId: string;
  channelId: string;
  userId: string;
  stage: 'stt' | 'llm' | 'tts';
  durationMs: number;
  success: boolean;
  emptyText?: boolean;
  failureCode?: string;
  vadScore?: number;
  captureDurationMs?: number;
};

export type VoiceConnectionRecoveryEvent = {
  guildId: string;
  channelId: string;
  status: 'reconnecting' | 'recovered' | 'failed';
  attempt?: number;
  maxAttempts: number;
};

type ActiveVoiceSession = {
  connection: VoiceConnection;
  player: AudioPlayer;
  channel: VoiceBasedChannel;
  botUserId: string;
  recognitionLanguage: VoiceRecognitionLanguage;
  startedAt: string;
  processingUserId?: string;
  capturingUserId?: string;
  activeRequest?: AbortController;
  greetingRequest?: AbortController;
  idleNudgeRequest?: AbortController;
  idleNudgeTimer?: NodeJS.Timeout;
  idleNudge?: { text: string; voiceProfile: VoiceProfile; delayMs: number; maxCount: number };
  idleDisconnectRequest?: AbortController;
  idleDisconnectTimer?: NodeJS.Timeout;
  idleDisconnectFallbackTimer?: NodeJS.Timeout;
  idleDisconnect?: { text: string; voiceProfile: VoiceProfile; delayMs: number };
  idleDisconnecting?: boolean;
  lastHumanActivityAt: number;
  lastIdleNudgeAt: number;
  idleNudgeCount: number;
  activePlayback?: PcmSpeechPipeline;
  playbackUserId?: string;
  pendingBargeInUserId?: string;
  queuedVoiceTurns: QueuedVoiceTurn[];
  queuedVoiceTurnDrainActive: boolean;
  recentAssistantPhrases: Array<{ text: string; expiresAt: number }>;
  vadNoiseFloor: number;
  reconnecting?: Promise<void>;
  reconnectTimer?: NodeJS.Timeout;
  reconnectDelayResolve?: () => void;
  paused?: boolean;
};

type PendingVoiceStart = {
  channelId: string;
  promise: Promise<VoiceSessionStatus>;
};

type QueuedVoiceTurn = {
  userId: string;
  text: string;
  confidence?: number;
  occurredAt: string;
};

type VoiceLogger = Pick<Console, 'error' | 'info' | 'warn'> & {
  detail?: (...details: unknown[]) => void;
};


type VoiceSessionManagerOptions = {
  conversationApi: ConversationApi;
  voiceService: VoiceServiceClient;
  maxPcmBytes?: number;
  logger?: VoiceLogger;
  onBargeIn?: (input: { guildId: string; channelId: string; userId: string }) => void | Promise<void>;
  shouldInterruptImmediately?: (input: VoiceConsentCheck) => boolean | Promise<boolean>;
  onMetric?: (input: VoiceProcessingMetric) => void | Promise<void>;
  canProcessVoice: (input: VoiceConsentCheck) => Promise<boolean>;
  onVoiceConsentRequired?: (input: VoiceConsentCheck) => void | Promise<void>;
  onConnectionRecovery?: (input: VoiceConnectionRecoveryEvent) => void | Promise<void>;
  /** Resolves the active speaker's website language immediately before STT. */
  resolveRecognitionLanguage?: (input: VoiceConsentCheck & { fallback: VoiceRecognitionLanguage }) => Promise<VoiceRecognitionLanguage>;
  resolveVoiceProfile?: (input: { turn: TurnEnvelope; profile: VoiceProfile }) => Promise<VoiceProfile>;
};

/**
 * The hot path is deliberately pipelined: adaptive endpointing -> STT -> Gemini
 * SSE -> sentence TTS -> one continuous PCM Discord playback stream.
 */
export class VoiceSessionManager {
  private readonly sessions = new Map<string, ActiveVoiceSession>();
  // A guild can emit several VoiceStateUpdate events while Discord is still
  // negotiating UDP. Keep those requests on one connection instead of letting
  // a later join replace (and close) the socket of an earlier join.
  private readonly pendingStarts = new Map<string, PendingVoiceStart>();
  private readonly lastConsentNoticeAt = new Map<string, number>();
  private readonly lastVoiceConsentDenialAt = new Map<string, number>();
  // A withdrawal event can arrive before this process has seen a given
  // guild/channel scope. Keep a short user-level denial as a safety net; it
  // expires into the normal settings re-check just like the scope cache.
  private readonly lastVoiceConsentDenialAtByUser = new Map<string, number>();
  private readonly maxPcmBytes: number;
  private readonly logger: VoiceLogger;

  constructor(private readonly options: VoiceSessionManagerOptions) {
    this.maxPcmBytes = options.maxPcmBytes ?? 12 * 1024 * 1024;
    this.logger = options.logger ?? console;
  }

  async start(input: StartVoiceSessionInput): Promise<VoiceSessionStatus> {
    const guildId = input.channel.guild.id;
    const existing = this.sessions.get(guildId);
    if (existing) {
      if (existing.channel.id === input.channel.id) return this.statusOf(existing);
      throw new Error('Only one voice channel can be processed per guild. Leave the existing session first.');
    }

    const pending = this.pendingStarts.get(guildId);
    if (pending) {
      if (pending.channelId === input.channel.id) {
        this.detail(`Voice join already in progress: guild=${guildId}, channel=${pending.channelId}.`);
        return pending.promise;
      }
      throw new Error('A voice-channel connection is already in progress for this server. Try again in a moment.');
    }

    const startPromise = this.startNewSession(input);
    this.pendingStarts.set(guildId, { channelId: input.channel.id, promise: startPromise });
    try {
      return await startPromise;
    } finally {
      if (this.pendingStarts.get(guildId)?.promise === startPromise) this.pendingStarts.delete(guildId);
    }
  }

  private async startNewSession(input: StartVoiceSessionInput): Promise<VoiceSessionStatus> {
    const guildId = input.channel.guild.id;
    const connection = joinVoiceChannel({
      channelId: input.channel.id,
      guildId,
      adapterCreator: input.channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    // The library may emit this during UDP IP discovery, before the connection
    // reaches Ready. Attach the listener immediately so it never becomes an
    // unhandled EventEmitter error.
    connection.on('error', (error) => this.logger.warn(`Voice connection error: guild=${guildId}, ${messageOf(error)}`));
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      connection.destroy();
      throw new Error(`Could not connect to the voice channel: ${messageOf(error)}`);
    }

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(player);
    const session: ActiveVoiceSession = {
      connection,
      player,
      channel: input.channel,
      botUserId: input.botUserId,
      recognitionLanguage: input.recognitionLanguage ?? 'auto',
      startedAt: new Date().toISOString(),
      idleNudge: input.idleNudge
        ? {
            text: input.idleNudge.text,
            voiceProfile: input.idleNudge.voiceProfile,
            delayMs: input.idleNudge.delayMs ?? 60_000,
            maxCount: input.idleNudge.maxCount ?? 2
          }
        : undefined,
      idleDisconnect: input.idleDisconnect
        ? {
            text: input.idleDisconnect.text,
            voiceProfile: input.idleDisconnect.voiceProfile,
            delayMs: input.idleDisconnect.delayMs ?? 10 * 60_000
          }
        : undefined,
      lastHumanActivityAt: Date.now(),
      lastIdleNudgeAt: Date.now(),
      idleNudgeCount: 0,
      queuedVoiceTurns: [],
      queuedVoiceTurnDrainActive: false,
      recentAssistantPhrases: [],
      vadNoiseFloor: VAD_INITIAL_NOISE_FLOOR,
    };
    this.sessions.set(guildId, session);

    connection.receiver.speaking.on('start', (userId) => {
      if (userId !== session.botUserId) this.detail(`Voice activity detected: user=${userId}`);
      this.handleVoiceActivity(session, userId);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.logger.warn(`Voice connection disconnected: guild=${guildId}`);
      void this.recoverConnection(session);
    });
    player.on('error', (error) => this.logVoiceFailure(`Voice playback failed: guild=${guildId}`, error));
    player.on('stateChange', (before, after) => {
      if (before.status !== after.status) this.detail(`Voice player state: ${before.status} -> ${after.status}`);
      if (after.status === AudioPlayerStatus.Idle) session.playbackUserId = undefined;
    });
    if (input.greeting?.text.trim()) void this.playGreeting(session, input.greeting);
    this.scheduleIdleNudge(session);
    this.scheduleIdleDisconnect(session);
    this.logger.info(`Voice session started: guild=${guildId}, channel=${input.channel.id}`);
    return this.statusOf(session);
  }
  stop(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    this.cancelReconnect(session);
    this.interrupt(session);
    session.connection.destroy();
    this.sessions.delete(guildId);
    this.logger.info(`Voice session stopped: guild=${guildId}`);
    return true;
  }

  stopAll(): number {
    const guildIds = [...this.sessions.keys()];
    for (const guildId of guildIds) this.stop(guildId);
    const pendingConnections = [...getVoiceConnections().values()];
    for (const connection of pendingConnections) connection.destroy();
    return guildIds.length + pendingConnections.length;
  }

  /** Keeps the bot connected but stops every active or queued voice turn. */
  pauseAll(): number {
    let paused = 0;
    for (const session of this.sessions.values()) {
      if (session.paused) continue;
      session.paused = true;
      this.interrupt(session);
      session.queuedVoiceTurns = [];
      paused += 1;
    }
    return paused;
  }

  /** Allows connected voice sessions to process new speech again. */
  resumeAll(): number {
    let resumed = 0;
    for (const session of this.sessions.values()) {
      if (!session.paused) continue;
      session.paused = false;
      this.scheduleIdleNudge(session);
      resumed += 1;
    }
    return resumed;
  }
  getStatus(guildId: string): VoiceSessionStatus | undefined {
    const session = this.sessions.get(guildId);
    return session ? this.statusOf(session) : undefined;
  }

  setRecognitionLanguage(guildId: string, language: VoiceRecognitionLanguage): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    session.recognitionLanguage = language;
    this.detail(`Voice recognition language changed: guild=${guildId}, channel=${session.channel.id}, language=${language}.`);
    return true;
  }
  /**
   * Applies a website voice-consent change to every session in this process.
   * Grants clear every negative cache entry so the next utterance must query
   * the website again. Withdrawals immediately abort that user's active work
   * and install a short denial cache, so no new STT/AI/TTS work starts while
   * the website setting propagates through normal API reads.
   */
  invalidateVoiceConsent(userId: string, voiceConsent: boolean): void {
    for (const scope of this.lastVoiceConsentDenialAt.keys()) {
      if (scope.endsWith(`:${userId}`)) this.lastVoiceConsentDenialAt.delete(scope);
    }
    for (const scope of this.lastConsentNoticeAt.keys()) {
      if (scope.endsWith(`:${userId}`)) this.lastConsentNoticeAt.delete(scope);
    }

    if (voiceConsent) {
      this.lastVoiceConsentDenialAtByUser.delete(userId);
      this.detail(`Voice consent cache invalidated: user=${userId}, voiceConsent=true.`);
      return;
    }

    this.lastVoiceConsentDenialAtByUser.set(userId, Date.now());
    for (const session of this.sessions.values()) {
      if (session.capturingUserId === userId || session.processingUserId === userId) this.interrupt(session);
      session.queuedVoiceTurns = session.queuedVoiceTurns.filter((turn) => turn.userId !== userId);
    }
    this.detail(`Voice consent withdrawn: cancelled active and queued voice work for user=${userId}.`);
  }

  async speakForTextMessage(input: VoiceTextMessageInput): Promise<boolean> {
    const session = this.sessions.get(input.guildId);
    const text = limitVoiceText(input.text);
    if (!session || session.paused || session.channel.id !== input.channelId || !text) return false;

    this.markHumanActivity(session);
    this.interrupt(session);
    const abortController = new AbortController();
    session.activeRequest = abortController;
    session.processingUserId = input.userId;
    const turn: TurnEnvelope = {
      eventId: randomUUID(),
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      conversationId: `voice:${input.guildId}:${input.channelId}:${input.userId}`,
      modality: 'voice',
      source: 'voice_channel_text',
      canonicalText: text.slice(0, 2_000),
      occurredAt: new Date().toISOString()
    };

    try {
      this.detail(`Voice LLM -> turn: conversation=${turn.conversationId}, input=${logPreview(turn.canonicalText)}.`);
      const streamed = await this.playStreamedReply(session, turn, abortController);
      if (!streamed && !abortController.signal.aborted) await this.playBufferedReply(session, turn, abortController);
      return !abortController.signal.aborted;
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.logger.error(`Voice text-message processing failed: guild=${input.guildId}`, error);
      }
      return false;
    } finally {
      if (session.activeRequest === abortController) {
        session.activeRequest = undefined;
        session.processingUserId = undefined;
      }
      this.scheduleIdleNudge(session);
    }
  }

  private handleVoiceActivity(session: ActiveVoiceSession, userId: string): void {
    if (userId === session.botUserId) return;
    if (session.paused) {
      this.detail(`Voice activity ignored: user=${userId}, reason=voice-session-paused.`);
      return;
    }
    const consent = { guildId: session.channel.guild.id, channelId: session.channel.id, userId };
    if (this.hasRecentVoiceConsentDenial(consent)) {
      this.detail(`Voice activity ignored: user=${userId}, reason=voice-consent-not-granted.`);
      return;
    }
    this.markHumanActivity(session);

    // Generating a cosmetic greeting is not the same as speaking. If a person
    // starts before the greeting reaches Discord, discard that stale greeting
    // and treat their utterance as the first real turn in the conversation.
    if (session.greetingRequest && !this.isPlaying(session)) {
      session.greetingRequest.abort();
      session.greetingRequest = undefined;
      this.detail(`Voice greeting cancelled by incoming speech: user=${userId}`);
      void this.handleSpeaker(session, userId);
      return;
    }

    // Discord can emit several `speaking.start` pulses for one utterance.
    // While the same user's STT/LLM request is already running, keep the
    // capture alive instead of aborting the request and starting a duplicate.
    if (
      session.processingUserId &&
      session.processingUserId === userId &&
      session.activeRequest &&
      !this.isPlaying(session)
    ) {
      this.detail(`Voice activity ignored: user=${userId}, reason=already-processing.`);
      return;
    }

    if (session.processingUserId && session.activeRequest && !this.isPlaying(session)) {
      this.detail(`Voice processing superseded by new speech: previous=${session.processingUserId}, user=${userId}.`);
      this.interrupt(session);
      void this.handleSpeaker(session, userId);
      return;
    }
    if (this.isPlaying(session)) {
      void this.confirmBargeIn(session, userId);
      return;
    }
    void this.handleSpeaker(session, userId);
  }

  private async confirmBargeIn(session: ActiveVoiceSession, userId: string): Promise<void> {
    if (session.pendingBargeInUserId) return;
    // A voice-channel session may have several consenting participants. Speech
    // from somebody other than the person Seline is currently replying to is
    // ambient conversation, not a request to interrupt or queue another turn.
    const playbackUserId = session.playbackUserId ?? session.processingUserId;
    if (playbackUserId && playbackUserId !== userId) {
      this.detail(`Voice activity ignored during playback: user=${userId}, activeUser=${playbackUserId}.`);
      return;
    }
    session.pendingBargeInUserId = userId;
    try {
      const consent = { guildId: session.channel.guild.id, channelId: session.channel.id, userId };
      if (!await this.canProcessVoice(consent)) {
        this.detail(`Voice interrupt ignored: user=${userId}, reason=voice-consent-not-granted.`);
        this.notifyVoiceConsentRequired(consent);
        return;
      }
      if (await this.options.shouldInterruptImmediately?.(consent)) {
        this.logger.info(`Voice interrupt accepted immediately: user=${userId}`);
        await Promise.resolve(this.options.onBargeIn?.({
          guildId: session.channel.guild.id,
          channelId: session.channel.id,
          userId
        })).catch((error: unknown) => this.logger.warn(`Failed to record voice barge-in: ${messageOf(error)}`));
        this.interrupt(session);
        return;
      }
      this.detail(`Voice interrupt check started: user=${userId}.`);
      await waitForSpeechConfirmation();
      if (this.sessions.get(session.channel.guild.id) !== session) return;
      if (!session.connection.receiver.speaking.users.has(userId)) return;

      // Normal speech must not cut Seline off. While she is playing, listen
      // only long enough to recognise an explicit interruption request.
      const capture = await captureSpeakerPcm(session.connection, userId, this.maxPcmBytes, session.vadNoiseFloor);
      session.vadNoiseFloor = smoothVadNoiseFloor(session.vadNoiseFloor, capture.noiseFloor);
      if (!capture.pcm.length || this.sessions.get(session.channel.guild.id) !== session) return;
      let transcription;
      try {
        const recognitionLanguage = await this.resolveRecognitionLanguage(session, userId);
        transcription = await this.options.voiceService.transcribe({
          pcm: capture.pcm,
          guildId: session.channel.guild.id,
          channelId: session.channel.id,
          userId,
          language: recognitionLanguage
        });
      } catch (error) {
        throw error;
      }
      const text = limitVoiceText(transcription.text);
      if (this.isLikelyPlaybackEcho(session, text)) {
        this.logger.info(`Voice playback echo ignored: user=${userId}, text=${logPreview(text)}.`);
        return;
      }
      if (!isExplicitInterrupt(text)) {
        if (text) this.enqueueQueuedVoiceTurn(session, { userId, text, confidence: transcription.confidence, occurredAt: new Date().toISOString() });
        return;
      }

      this.logger.info(`Voice interrupt accepted: user=${userId}`);
      await Promise.resolve(this.options.onBargeIn?.({
        guildId: session.channel.guild.id,
        channelId: session.channel.id,
        userId
      })).catch((error: unknown) => this.logger.warn(`Failed to record voice barge-in: ${messageOf(error)}`));
      this.interrupt(session);
    } catch (error) {
      this.logger.warn(`Voice interrupt check failed: user=${userId}, ${messageOf(error)}`);
    } finally {
      if (session.pendingBargeInUserId === userId) session.pendingBargeInUserId = undefined;
    }
  }

  private async resolveVoiceProfile(turn: TurnEnvelope, profile: VoiceProfile): Promise<VoiceProfile> {
    try {
      return await this.options.resolveVoiceProfile?.({ turn, profile }) ?? profile;
    } catch (error) {
      this.logger.warn('Voice profile settings lookup failed: ' + messageOf(error));
      return profile;
    }
  }

  private async resolveRecognitionLanguage(session: ActiveVoiceSession, userId: string): Promise<VoiceRecognitionLanguage> {
    const input = {
      guildId: session.channel.guild.id,
      channelId: session.channel.id,
      userId,
      fallback: session.recognitionLanguage
    };
    try {
      return await this.options.resolveRecognitionLanguage?.(input) ?? input.fallback;
    } catch (error) {
      this.logger.warn('Voice recognition language lookup failed: ' + messageOf(error));
      return input.fallback;
    }
  }

  private reportMetric(input: VoiceProcessingMetric): void {
    void Promise.resolve(this.options.onMetric?.(input)).catch((error: unknown) => {
      this.logger.warn('Voice metric reporting failed: ' + messageOf(error));
    });
  }

  private async recoverConnection(session: ActiveVoiceSession): Promise<void> {
    if (session.reconnecting) return session.reconnecting;
    if (this.sessions.get(session.channel.guild.id) !== session) return;

    const recovery = this.recoverDisconnectedSession(session);
    session.reconnecting = recovery;
    try {
      await recovery;
    } finally {
      if (session.reconnecting === recovery) session.reconnecting = undefined;
    }
  }

  private async recoverDisconnectedSession(session: ActiveVoiceSession): Promise<void> {
    const guildId = session.channel.guild.id;
    const maxAttempts = VOICE_RECONNECT_DELAYS_MS.length;
    this.interrupt(session);
    this.notifyConnectionRecovery({ guildId, channelId: session.channel.id, status: 'reconnecting', maxAttempts });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const delayMs = voiceReconnectDelayMs(attempt);
      if (delayMs === undefined) break;
      await this.waitForReconnectDelay(session, delayMs);
      if (this.sessions.get(guildId) !== session || session.connection.state.status === VoiceConnectionStatus.Destroyed) return;
      if (session.connection.state.status === VoiceConnectionStatus.Ready) {
        this.notifyConnectionRecovery({ guildId, channelId: session.channel.id, status: 'recovered', maxAttempts });
        return;
      }

      this.logger.info(`Voice reconnect attempt ${attempt}/${maxAttempts}: guild=${guildId}.`);
      try {
        if (!session.connection.rejoin()) throw new Error('Discord rejected the voice reconnect request.');
        await entersState(session.connection, VoiceConnectionStatus.Ready, VOICE_RECONNECT_READY_TIMEOUT_MS);
        if (this.sessions.get(guildId) !== session) return;
        this.logger.info(`Voice connection recovered: guild=${guildId}, attempt=${attempt}.`);
        this.notifyConnectionRecovery({ guildId, channelId: session.channel.id, status: 'recovered', attempt, maxAttempts });
        return;
      } catch (error) {
        this.logger.warn(`Voice reconnect attempt failed: guild=${guildId}, attempt=${attempt}, ${messageOf(error)}`);
      }
    }

    if (this.sessions.get(guildId) !== session) return;
    this.logger.error(`Voice reconnect exhausted: guild=${guildId}, attempts=${maxAttempts}.`);
    this.notifyConnectionRecovery({ guildId, channelId: session.channel.id, status: 'failed', maxAttempts });
    this.stop(guildId);
  }

  private waitForReconnectDelay(session: ActiveVoiceSession, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const complete = () => {
        if (session.reconnectTimer === timer) session.reconnectTimer = undefined;
        if (session.reconnectDelayResolve === complete) session.reconnectDelayResolve = undefined;
        resolve();
      };
      const timer = setTimeout(complete, delayMs);
      timer.unref?.();
      session.reconnectTimer = timer;
      session.reconnectDelayResolve = complete;
    });
  }

  private cancelReconnect(session: ActiveVoiceSession): void {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
    session.reconnectDelayResolve?.();
    session.reconnectDelayResolve = undefined;
  }

  private notifyConnectionRecovery(input: VoiceConnectionRecoveryEvent): void {
    void Promise.resolve(this.options.onConnectionRecovery?.(input)).catch((error: unknown) => {
      this.logger.warn(`Voice recovery notice failed: guild=${input.guildId}, ${messageOf(error)}`);
    });
  }

  private logVoiceFailure(context: string, error: unknown): void {
    const detail = messageOf(error);
    if (/voice synthesis request failed \(503\)|exceeded your current quota|billing details/i.test(detail)) {
      // Gemini quota is an operational condition, not a bot crash. Keep this
      // concise so a single failed reply does not produce several stack dumps.
      this.logger.warn(`${context}: TTS is temporarily unavailable because the Gemini quota is exhausted; Korean local fallback requires eunjeon.`);
      return;
    }
    this.logger.error(context, error);
  }
  private detail(message: string): void {
    this.logger.detail?.(message);
  }
  private consentScope(input: VoiceConsentCheck): string {
    return `${input.guildId}:${input.channelId}:${input.userId}`;
  }

  private hasRecentVoiceConsentDenial(input: VoiceConsentCheck): boolean {
    const now = Date.now();
    const scope = this.consentScope(input);
    const deniedAt = this.lastVoiceConsentDenialAt.get(scope);
    if (deniedAt !== undefined && now - deniedAt < VOICE_CONSENT_DENIAL_CACHE_MS) return true;
    if (deniedAt !== undefined) this.lastVoiceConsentDenialAt.delete(scope);
    const deniedForUserAt = this.lastVoiceConsentDenialAtByUser.get(input.userId);
    if (deniedForUserAt !== undefined && now - deniedForUserAt < VOICE_CONSENT_DENIAL_CACHE_MS) return true;
    if (deniedForUserAt !== undefined) this.lastVoiceConsentDenialAtByUser.delete(input.userId);
    return false;
  }

  async canProcessVoice(input: VoiceConsentCheck): Promise<boolean> {
    const scope = this.consentScope(input);
    if (this.hasRecentVoiceConsentDenial(input)) return false;

    try {
      const allowed = await this.options.canProcessVoice(input);
      if (allowed) this.lastVoiceConsentDenialAt.delete(scope);
      else this.lastVoiceConsentDenialAt.set(scope, Date.now());
      return allowed;
    } catch (error) {
      this.lastVoiceConsentDenialAt.set(scope, Date.now());
      this.logger.warn(`Voice consent check failed: user=${input.userId}, ${messageOf(error)}`);
      return false;
    }
  }

  private notifyVoiceConsentRequired(input: VoiceConsentCheck): void {
    const key = `${input.guildId}:${input.channelId}:${input.userId}`;
    const now = Date.now();
    const previous = this.lastConsentNoticeAt.get(key) ?? 0;
    if (now - previous < VOICE_CONSENT_NOTICE_COOLDOWN_MS) return;
    this.lastConsentNoticeAt.set(key, now);
    void Promise.resolve(this.options.onVoiceConsentRequired?.(input)).catch((error: unknown) => {
      this.logger.warn(`Voice consent notice failed: user=${input.userId}, ${messageOf(error)}`);
    });
  }
  private isPlaying(session: ActiveVoiceSession): boolean {
    return session.player.state.status === AudioPlayerStatus.Playing || session.player.state.status === AudioPlayerStatus.Buffering;
  }

  private markHumanActivity(session: ActiveVoiceSession): void {
    session.lastHumanActivityAt = Date.now();
    session.lastIdleNudgeAt = session.lastHumanActivityAt;
    session.idleNudgeCount = 0;
    this.cancelIdleNudge(session);
    this.cancelIdleDisconnect(session);
    this.scheduleIdleNudge(session);
    this.scheduleIdleDisconnect(session);
  }

  private rememberAssistantSpeech(session: ActiveVoiceSession, text: string): void {
    const normalized = normalizePlaybackEchoText(text);
    if (normalized.split(' ').filter(Boolean).length < 3) return;
    const now = Date.now();
    session.recentAssistantPhrases = session.recentAssistantPhrases
      .filter((phrase) => phrase.expiresAt > now)
      .concat({ text: normalized, expiresAt: now + VOICE_PLAYBACK_ECHO_WINDOW_MS })
      .slice(-12);
  }

  private isLikelyPlaybackEcho(session: ActiveVoiceSession, text: string): boolean {
    const now = Date.now();
    session.recentAssistantPhrases = session.recentAssistantPhrases.filter((phrase) => phrase.expiresAt > now);
    return isLikelyPlaybackEcho(text, session.recentAssistantPhrases.map((phrase) => phrase.text));
  }
  private scheduleIdleNudge(session: ActiveVoiceSession): void {
    const nudge = session.idleNudge;
    if (!nudge || session.idleNudgeCount >= nudge.maxCount || this.sessions.get(session.channel.guild.id) !== session) return;
    this.clearIdleNudgeTimer(session);
    const elapsedMs = Date.now() - Math.max(session.lastHumanActivityAt, session.lastIdleNudgeAt);
    const dueMs = Math.max(0, nudge.delayMs - elapsedMs);
    session.idleNudgeTimer = setTimeout(() => {
      session.idleNudgeTimer = undefined;
      void this.playIdleNudge(session);
    }, dueMs);
    session.idleNudgeTimer.unref?.();
  }

  private async playIdleNudge(session: ActiveVoiceSession): Promise<void> {
    const nudge = session.idleNudge;
    if (!nudge || this.sessions.get(session.channel.guild.id) !== session || session.idleNudgeCount >= nudge.maxCount) return;
    if (Date.now() - session.lastHumanActivityAt < nudge.delayMs) {
      this.scheduleIdleNudge(session);
      return;
    }
    if (
      this.isPlaying(session) ||
      session.greetingRequest ||
      session.activeRequest ||
      session.capturingUserId ||
      !session.channel.members.some((member) => !member.user.bot)
    ) {
      session.lastHumanActivityAt = Date.now();
      this.scheduleIdleNudge(session);
      return;
    }

    session.idleNudgeCount += 1;
    session.lastIdleNudgeAt = Date.now();
    const controller = new AbortController();
    session.idleNudgeRequest = controller;
    try {
      const audio = await this.options.voiceService.synthesizePcm({
        text: nudge.text,
        voiceProfile: nudge.voiceProfile,
        signal: controller.signal
      });
      if (controller.signal.aborted || this.sessions.get(session.channel.guild.id) !== session) {
        audio.destroy();
        return;
      }
      session.player.play(
        createAudioResource(audio, {
          inputType: StreamType.Raw,
          metadata: { voiceProfileId: nudge.voiceProfile.id }
        })
      );
    } catch (error) {
      if (!controller.signal.aborted) this.logger.warn(`Voice idle nudge failed: ${messageOf(error)}`);
    } finally {
      if (session.idleNudgeRequest === controller) session.idleNudgeRequest = undefined;
      this.scheduleIdleNudge(session);
    }
  }

  private clearIdleNudgeTimer(session: ActiveVoiceSession): void {
    if (session.idleNudgeTimer) clearTimeout(session.idleNudgeTimer);
    session.idleNudgeTimer = undefined;
  }

  private cancelIdleNudge(session: ActiveVoiceSession): void {
    this.clearIdleNudgeTimer(session);
    session.idleNudgeRequest?.abort();
    session.idleNudgeRequest = undefined;
  }

  private scheduleIdleDisconnect(session: ActiveVoiceSession): void {
    const idleDisconnect = session.idleDisconnect;
    if (!idleDisconnect || session.idleDisconnecting || this.sessions.get(session.channel.guild.id) !== session) return;
    if (session.idleDisconnectTimer) clearTimeout(session.idleDisconnectTimer);
    const dueMs = Math.max(0, idleDisconnect.delayMs - (Date.now() - session.lastHumanActivityAt));
    session.idleDisconnectTimer = setTimeout(() => {
      session.idleDisconnectTimer = undefined;
      void this.disconnectForInactivity(session);
    }, dueMs);
    session.idleDisconnectTimer.unref?.();
  }

  private async disconnectForInactivity(session: ActiveVoiceSession): Promise<void> {
    const idleDisconnect = session.idleDisconnect;
    if (!idleDisconnect || session.idleDisconnecting || this.sessions.get(session.channel.guild.id) !== session) return;
    if (Date.now() - session.lastHumanActivityAt < idleDisconnect.delayMs) {
      this.scheduleIdleDisconnect(session);
      return;
    }
    if (!session.channel.members.some((member) => !member.user.bot)) {
      this.stop(session.channel.guild.id);
      return;
    }
    if (this.isPlaying(session) || session.greetingRequest || session.activeRequest || session.capturingUserId) {
      session.idleDisconnectTimer = setTimeout(() => void this.disconnectForInactivity(session), 5_000);
      session.idleDisconnectTimer.unref?.();
      return;
    }

    session.idleDisconnecting = true;
    this.cancelIdleNudge(session);
    const controller = new AbortController();
    session.idleDisconnectRequest = controller;
    try {
      this.rememberAssistantSpeech(session, idleDisconnect.text);
      const audio = await this.options.voiceService.synthesizePcm({ text: idleDisconnect.text, voiceProfile: idleDisconnect.voiceProfile, signal: controller.signal });
      if (controller.signal.aborted || this.sessions.get(session.channel.guild.id) !== session || !session.idleDisconnecting) {
        audio.destroy();
        return;
      }
      const leave = () => {
        if (session.idleDisconnecting && this.sessions.get(session.channel.guild.id) === session) this.stop(session.channel.guild.id);
      };
      session.idleDisconnectFallbackTimer = setTimeout(leave, 30_000);
      session.idleDisconnectFallbackTimer.unref?.();
      session.player.once(AudioPlayerStatus.Idle, leave);
      session.player.play(createAudioResource(audio, { inputType: StreamType.Raw, metadata: { voiceProfileId: idleDisconnect.voiceProfile.id } }));
      this.logger.info(`Voice session leaving after inactivity: guild=${session.channel.guild.id}`);
    } catch (error) {
      if (!controller.signal.aborted) this.logger.warn(`Voice idle disconnect farewell failed: ${messageOf(error)}`);
      if (this.sessions.get(session.channel.guild.id) === session) this.stop(session.channel.guild.id);
    } finally {
      if (session.idleDisconnectRequest === controller) session.idleDisconnectRequest = undefined;
    }
  }

  private cancelIdleDisconnect(session: ActiveVoiceSession): void {
    if (session.idleDisconnectTimer) clearTimeout(session.idleDisconnectTimer);
    session.idleDisconnectTimer = undefined;
    if (session.idleDisconnectFallbackTimer) clearTimeout(session.idleDisconnectFallbackTimer);
    session.idleDisconnectFallbackTimer = undefined;
    session.idleDisconnectRequest?.abort();
    session.idleDisconnectRequest = undefined;
    session.idleDisconnecting = false;
  }

  private async handleSpeaker(
    session: ActiveVoiceSession,
    userId: string,
    options: { deferGreetingInterrupt?: boolean } = {}
  ): Promise<void> {
    if (userId === session.botUserId) return;
    // Discord can emit repeated speaking-start events for one utterance. Do not
    // abort an in-flight capture/STT request when that happens.
    if (session.capturingUserId || session.processingUserId) {
      this.detail(`Voice activity ignored: user=${userId}, capture=${session.capturingUserId ?? 'none'}, processing=${session.processingUserId ?? 'none'}.`);
      return;
    }
    if (!options.deferGreetingInterrupt) this.interrupt(session);

    const abortController = new AbortController();
    // Reserve synchronously, before asynchronous capture work. A
    // single Discord utterance often emits several speaking-start events.
    session.capturingUserId = userId;
    session.activeRequest = abortController;
    const turnStartedAt = performance.now();
    try {
      // Subscribe immediately. A settings round trip can take longer than a
      // short greeting, and subscribing only after it returns loses the
      // beginning (or all) of that utterance. Captured PCM remains local and
      // is discarded without STT whenever consent is denied.
      const capturePromise = captureSpeakerPcm(
        session.connection,
        userId,
        this.maxPcmBytes,
        session.vadNoiseFloor,
        abortController.signal
      );
      let consent: boolean;
      try {
        consent = await this.canProcessVoice({
          guildId: session.channel.guild.id,
          channelId: session.channel.id,
          userId
        });
      } catch (error) {
        abortController.abort();
        await capturePromise.catch(() => undefined);
        throw error;
      }
      this.detail(`Voice consent result: user=${userId}, allowed=${String(consent)}, aborted=${String(abortController.signal.aborted)}.`);
      if (!consent || abortController.signal.aborted) {
        abortController.abort();
        await capturePromise.catch(() => undefined);
        if (!consent) {
          this.detail(`Voice input skipped before STT: user=${userId}, reason=voice-consent-not-granted.`);
          this.notifyVoiceConsentRequired({ guildId: session.channel.guild.id, channelId: session.channel.id, userId });
        }
        return;
      }

      this.detail(`Voice capture started: user=${userId}.`);
      const capture = await capturePromise;
      session.vadNoiseFloor = smoothVadNoiseFloor(session.vadNoiseFloor, capture.noiseFloor);
      if (session.activeRequest === abortController) {
        session.capturingUserId = undefined;
        session.processingUserId = userId;
      }
      if (!capture.pcm.length || abortController.signal.aborted) {
        this.detail(`Voice capture ignored: user=${userId}, reason=${capture.discardReason}, captured=${Math.round(capture.capturedMs)}ms, voiced=${Math.round(capture.voicedMs)}ms, avgRms=${Math.round(capture.averageRms)}, peakRms=${Math.round(capture.peakRms)}.`);
        return;
      }
      this.logger.info(`Voice endpointed in ${elapsedMs(turnStartedAt)} ms (${capture.pcm.length} PCM bytes; captured=${Math.round(capture.capturedMs)}ms, voiced=${Math.round(capture.voicedMs)}ms, avgRms=${Math.round(capture.averageRms)}, peakRms=${Math.round(capture.peakRms)}).`);

      const sttStartedAt = performance.now();
      const recognitionLanguage = await this.resolveRecognitionLanguage(session, userId);
      this.detail(`Voice STT started: user=${userId}, language=${recognitionLanguage}, timeout=10000ms.`);
      let transcription;
      try {
        transcription = await this.options.voiceService.transcribe({
          pcm: capture.pcm,
          guildId: session.channel.guild.id,
          channelId: session.channel.id,
          userId,
          language: recognitionLanguage,
          signal: abortController.signal
        });
        const canonicalText = limitVoiceText(transcription.text);
        const lowConfidence = !voiceTranscriptionIsConfident(transcription.confidence);
        this.reportMetric({
          guildId: session.channel.guild.id, channelId: session.channel.id, userId, stage: 'stt',
          durationMs: elapsedMs(sttStartedAt), success: Boolean(canonicalText) && !lowConfidence, emptyText: !canonicalText,
          failureCode: lowConfidence ? 'low_confidence' : undefined,
          vadScore: Math.round(capture.averageRms), captureDurationMs: Math.round(capture.capturedMs)
        });
        if (!canonicalText || lowConfidence || abortController.signal.aborted) {
          if (lowConfidence) this.logger.warn(`Voice STT rejected: user=${userId}, confidence=${transcription.confidence?.toFixed(3)}, text=${logPreview(canonicalText)}.`);
          return;
        }
      } catch (error) {
        this.reportMetric({
          guildId: session.channel.guild.id, channelId: session.channel.id, userId, stage: 'stt',
          durationMs: elapsedMs(sttStartedAt), success: false, failureCode: errorCode(error),
          vadScore: Math.round(capture.averageRms), captureDurationMs: Math.round(capture.capturedMs)
        });
        throw error;
      }
      const canonicalText = limitVoiceText(transcription.text);
      const sttDurationMs = elapsedMs(sttStartedAt);
      const realtimeFactor = capture.capturedMs > 0 ? (sttDurationMs / capture.capturedMs).toFixed(2) : 'n/a';
      this.logger.info(`Voice STT completed in ${sttDurationMs} ms (RTF=${realtimeFactor}x).`);
      this.detail(`Voice STT result: text=${logPreview(canonicalText)}, confidence=${String(transcription.confidence ?? 'n/a')}.`);

      const turn: TurnEnvelope = {
        eventId: randomUUID(),
        guildId: session.channel.guild.id,
        channelId: session.channel.id,
        userId,
        conversationId: `voice:${session.channel.guild.id}:${session.channel.id}:${userId}`,
        modality: 'voice',
        source: 'voice_transcript',
        canonicalText,
        occurredAt: new Date().toISOString(),
        sttConfidence: transcription.confidence
      };
      this.detail(`Voice LLM -> turn: conversation=${turn.conversationId}, input=${logPreview(turn.canonicalText)}.`);
      const streamed = await this.playStreamedReply(session, turn, abortController);
      if (!streamed && !abortController.signal.aborted) await this.playBufferedReply(session, turn, abortController);
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.logVoiceFailure(`Voice processing failed: guild=${session.channel.guild.id}, user=${userId}`, error);
      }
    } finally {
      if (session.activeRequest === abortController) {
        session.activeRequest = undefined;
        session.capturingUserId = undefined;
        session.processingUserId = undefined;
      }
    }
  }

  private enqueueQueuedVoiceTurn(session: ActiveVoiceSession, queued: QueuedVoiceTurn): void {
    // Retain a small, ordered buffer while Seline is speaking. The oldest
    // pending utterance is discarded only when people speak over her repeatedly.
    if (session.queuedVoiceTurns.length >= 3) session.queuedVoiceTurns.shift();
    session.queuedVoiceTurns.push(queued);
    this.logger.info(`Voice turn queued until playback ends: user=${queued.userId}, queued=${session.queuedVoiceTurns.length}.`);
    void this.drainQueuedVoiceTurns(session);
  }

  private async drainQueuedVoiceTurns(session: ActiveVoiceSession): Promise<void> {
    if (session.queuedVoiceTurnDrainActive) return;
    session.queuedVoiceTurnDrainActive = true;
    try {
      while (session.queuedVoiceTurns.length && !session.paused && this.sessions.get(session.channel.guild.id) === session) {
        if (this.isPlaying(session) || session.greetingRequest || session.activeRequest || session.capturingUserId || session.processingUserId) {
          await wait(150);
          continue;
        }
        const queued = session.queuedVoiceTurns.shift();
        if (!queued) continue;
        const abortController = new AbortController();
        session.activeRequest = abortController;
        session.processingUserId = queued.userId;
        const turn: TurnEnvelope = {
          eventId: randomUUID(),
          guildId: session.channel.guild.id,
          channelId: session.channel.id,
          userId: queued.userId,
          conversationId: `voice:${session.channel.guild.id}:${session.channel.id}:${queued.userId}`,
          modality: 'voice',
          source: 'voice_transcript',
          canonicalText: queued.text,
          occurredAt: queued.occurredAt,
          sttConfidence: queued.confidence
        };
        try {
          this.logger.info(`Voice queued turn started: user=${queued.userId}.`);
          this.detail(`Voice LLM -> turn: conversation=${turn.conversationId}, input=${logPreview(turn.canonicalText)}.`);
      const streamed = await this.playStreamedReply(session, turn, abortController);
          if (!streamed && !abortController.signal.aborted) await this.playBufferedReply(session, turn, abortController);
        } catch (error) {
          if (!abortController.signal.aborted) this.logVoiceFailure(`Queued voice processing failed: guild=${session.channel.guild.id}, user=${queued.userId}`, error);
        } finally {
          if (session.activeRequest === abortController) {
            session.activeRequest = undefined;
            session.processingUserId = undefined;
          }
        }
      }
    } finally {
      session.queuedVoiceTurnDrainActive = false;
    }
  }

  private async playStreamedReply(
    session: ActiveVoiceSession,
    turn: TurnEnvelope,
    abortController: AbortController
  ): Promise<boolean> {
    const streamTurn = this.options.conversationApi.streamTurn;
    if (!streamTurn) return false;

    const generationStartedAt = performance.now();
    const sentences = new SentenceBuffer();
    let pipeline: PcmSpeechPipeline | undefined;
    let firstTokenLogged = false;
    for await (const chunk of streamTurn.call(this.options.conversationApi, turn)) {
      if (abortController.signal.aborted) return true;
      if (!firstTokenLogged && chunk.text) {
        firstTokenLogged = true;
        this.logger.info(`Voice LLM first token in ${elapsedMs(generationStartedAt)} ms.`);
      }
      if (!chunk.voiceProfile) continue;
      if (!pipeline) {
        const profile = await this.resolveVoiceProfile(turn, chunk.voiceProfile);
        pipeline = this.startPcmPlayback(session, profile, abortController.signal, turn);
      }
      for (const sentence of sentences.push(chunk.text)) {
        this.rememberAssistantSpeech(session, sentence);
        pipeline.enqueue(sentence);
      }
    }
    this.reportMetric({
      guildId: turn.guildId!, channelId: turn.channelId!, userId: turn.userId, stage: 'llm',
      durationMs: elapsedMs(generationStartedAt), success: true, emptyText: !firstTokenLogged
    });
    if (!pipeline) return true;
    for (const sentence of sentences.flush()) {
      this.rememberAssistantSpeech(session, sentence);
      pipeline.enqueue(sentence);
    }
    await pipeline.finish();
    if (session.activePlayback === pipeline) session.activePlayback = undefined;
    return true;
  }

  private async playBufferedReply(session: ActiveVoiceSession, turn: TurnEnvelope, abortController: AbortController): Promise<void> {
    const generationStartedAt = performance.now();
    let reply;
    try {
      reply = await this.options.conversationApi.createTurn(turn);
      this.reportMetric({ guildId: turn.guildId!, channelId: turn.channelId!, userId: turn.userId, stage: 'llm', durationMs: elapsedMs(generationStartedAt), success: true, emptyText: !reply.text.trim() });
    } catch (error) {
      this.reportMetric({ guildId: turn.guildId!, channelId: turn.channelId!, userId: turn.userId, stage: 'llm', durationMs: elapsedMs(generationStartedAt), success: false, failureCode: errorCode(error) });
      throw error;
    }
    if (!reply.text.trim() || !reply.voiceProfile || abortController.signal.aborted) return;
    const profile = await this.resolveVoiceProfile(turn, reply.voiceProfile);
    this.rememberAssistantSpeech(session, reply.text);
    this.logger.info(`Voice LLM completed in ${elapsedMs(generationStartedAt)} ms (non-streaming fallback).`);
    const ttsStartedAt = performance.now();
    let audio;
    try {
      audio = await this.options.voiceService.synthesize({
        text: reply.text,
        voiceProfile: profile,
        signal: abortController.signal
      });
      this.reportMetric({ guildId: turn.guildId!, channelId: turn.channelId!, userId: turn.userId, stage: 'tts', durationMs: elapsedMs(ttsStartedAt), success: true });
    } catch (error) {
      this.reportMetric({ guildId: turn.guildId!, channelId: turn.channelId!, userId: turn.userId, stage: 'tts', durationMs: elapsedMs(ttsStartedAt), success: false, failureCode: errorCode(error) });
      throw error;
    }
    if (abortController.signal.aborted) {
      audio.destroy();
      return;
    }
    const resource = createAudioResource(audio, { inputType: StreamType.OggOpus, metadata: { voiceProfileId: profile.id } });
    session.playbackUserId = turn.userId;
    session.player.play(resource);
  }

  private startPcmPlayback(session: ActiveVoiceSession, profile: VoiceProfile, signal: AbortSignal, turn: TurnEnvelope): PcmSpeechPipeline {
    const output = new PassThrough();
    const resource = createAudioResource(output, { inputType: StreamType.Raw, metadata: { voiceProfileId: profile.id } });
    const pipeline = new PcmSpeechPipeline(output, this.options.voiceService, profile, signal, (durationMs, success, failureCode) => {
      this.reportMetric({ guildId: turn.guildId!, channelId: turn.channelId!, userId: turn.userId, stage: 'tts', durationMs, success, failureCode });
    }, (message) => this.detail(message));
    session.activePlayback = pipeline;
    session.playbackUserId = turn.userId;
    session.player.play(resource);
    return pipeline;
  }

  private async playGreeting(
    session: ActiveVoiceSession,
    greeting: { text: string; voiceProfile: VoiceProfile }
  ): Promise<void> {
    const controller = new AbortController();
    session.greetingRequest = controller;
    try {
      this.rememberAssistantSpeech(session, greeting.text);
      const audio = await this.options.voiceService.synthesizePcm({
        text: greeting.text,
        voiceProfile: greeting.voiceProfile,
        signal: controller.signal
      });
      // A real speaker has priority over the cosmetic greeting.
      if (controller.signal.aborted) {
        audio.destroy();
        return;
      }
      session.player.play(
        createAudioResource(audio, {
          inputType: StreamType.Raw,
          metadata: { voiceProfileId: greeting.voiceProfile.id }
        })
      );
      this.logger.info('Voice greeting playback started.');
    } catch (error) {
      if (!controller.signal.aborted) this.logger.warn(`Voice greeting failed: ${messageOf(error)}`);
    } finally {
      if (session.greetingRequest === controller) session.greetingRequest = undefined;
    }
  }
  private interrupt(session: ActiveVoiceSession): void {
    session.activeRequest?.abort();
    session.activeRequest = undefined;
    session.greetingRequest?.abort();
    session.greetingRequest = undefined;
    this.cancelIdleNudge(session);
    this.cancelIdleDisconnect(session);
    session.processingUserId = undefined;
    session.capturingUserId = undefined;
    session.pendingBargeInUserId = undefined;
    session.activePlayback?.cancel();
    session.activePlayback = undefined;
    session.playbackUserId = undefined;
    if (session.player.state.status !== AudioPlayerStatus.Idle) session.player.stop(true);
  }

  private statusOf(session: ActiveVoiceSession): VoiceSessionStatus {
    return { guildId: session.channel.guild.id, channelId: session.channel.id, startedAt: session.startedAt };
  }
}

export class PcmSpeechPipeline {
  private readonly queue: Array<Promise<Readable | undefined>> = [];
  private activeStream?: Readable;
  private closed = false;
  private cancelled = false;
  private wake?: () => void;
  private readonly drainPromise: Promise<void>;

  constructor(
    private readonly output: PassThrough,
    private readonly voiceService: VoiceServiceClient,
    private readonly profile: VoiceProfile,
    private readonly signal: AbortSignal,
    private readonly onTtsResult?: (durationMs: number, success: boolean, failureCode?: string) => void,
    private readonly onTtsDetail?: (message: string) => void
  ) {
    this.drainPromise = this.drain();
    // Mark the background drain as observed immediately. finish() still awaits
    // and reports real failures, but Node can never promote an early rejection
    // to an uncaught exception while the model is still streaming later text.
    void this.drainPromise.catch(() => undefined);
  }

  enqueue(sentence: string): void {
    const text = sentence.trim();
    if (!text || this.closed || this.cancelled) return;
    // Begin network/TTS work immediately. While one sentence is audible, the
    // next sentence's PCM is already being prepared.
    const startedAt = performance.now();
    this.onTtsDetail?.('Voice TTS segment queued: chars=' + text.length + ', profile=' + this.profile.id + ', text=' + logPreview(text) + '.');
    this.queue.push(this.voiceService.synthesizePcm({ text, voiceProfile: this.profile, signal: this.signal }).then(
      (stream) => {
        // A fetch response body can emit AbortError synchronously when a
        // barge-in aborts a prefetched sentence. Until drain() reaches that
        // sentence there is otherwise no consumer/error listener, which lets
        // Node promote the expected cancellation to an uncaught exception.
        stream.on('error', () => undefined);
        this.onTtsResult?.(elapsedMs(startedAt), true);
        this.onTtsDetail?.('Voice TTS stream ready in ' + elapsedMs(startedAt) + ' ms.');
        return stream;
      },
      (error: unknown) => {
        // Barge-in and session shutdown intentionally abort every in-flight
        // sentence. Resolve those requests as empty work so a queued promise
        // cannot become an unhandled rejection after the drain loop exits.
        if (this.cancelled || this.signal.aborted || isAbortError(error)) {
          this.onTtsDetail?.('Voice TTS stream cancelled in ' + elapsedMs(startedAt) + ' ms.');
          return undefined;
        }
        this.onTtsResult?.(elapsedMs(startedAt), false, errorCode(error));
        this.onTtsDetail?.('Voice TTS stream failed in ' + elapsedMs(startedAt) + ' ms: ' + errorCode(error) + '.');
        throw error;
      }
    ));
    // Speculative segments can fail before the drain reaches them. Observe the
    // promise now, while preserving its rejection for drain()/finish() to report.
    const pending = this.queue.at(-1);
    if (pending) void pending.catch(() => undefined);
    this.wake?.();
    this.wake = undefined;
  }

  async finish(): Promise<void> {
    this.closed = true;
    this.wake?.();
    this.wake = undefined;
    await this.drainPromise;
  }

  cancel(): void {
    this.cancelled = true;
    this.closed = true;
    // Observe failures from every speculative TTS request, including segments
    // the drain loop has not reached yet. Their network abort is expected.
    for (const pending of this.queue) void pending.catch(() => undefined);
    this.activeStream?.destroy();
    this.activeStream = undefined;
    this.output.destroy();
    this.wake?.();
    this.wake = undefined;
  }

  private async drain(): Promise<void> {
    try {
      let playbackStarted = false;
      while (!this.cancelled) {
        const promise = await this.next();
        if (!promise) break;
        const stream = await promise;
        if (!stream || this.cancelled) break;
        this.activeStream = stream;
        let bytes = 0;
        let firstChunk = true;
        try {
          const iterator = stream[Symbol.asyncIterator]();
          while (!this.cancelled) {
            const next = playbackStarted
              ? await nextChunkWithSilence(iterator, stream, this.output, VOICE_TTS_STREAM_IDLE_TIMEOUT_MS)
              : await nextChunkWithTimeout(iterator, stream, VOICE_TTS_STREAM_IDLE_TIMEOUT_MS);
            if (next.done) break;
            const chunk = next.value;
            bytes += chunk.length;
            playbackStarted = true;
            if (firstChunk) {
              firstChunk = false;
              this.onTtsDetail?.('Voice TTS first PCM chunk: bytes=' + chunk.length + '.');
            }
            if (!this.output.write(chunk)) await waitForDrainWithTimeout(this.output, VOICE_TTS_STREAM_IDLE_TIMEOUT_MS);
          }
        } finally {
          if (this.activeStream === stream) this.activeStream = undefined;
        }
        if (bytes) this.onTtsDetail?.('Voice TTS PCM segment drained: bytes=' + bytes + '.');
      }
      if (!this.cancelled) this.output.end();
    } catch (error) {
      if (this.cancelled || this.signal.aborted || isAbortError(error)) {
        if (!this.output.destroyed) this.output.destroy();
        return;
      }
      this.output.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async next(): Promise<Promise<Readable | undefined> | undefined> {
    while (!this.queue.length && !this.closed && !this.cancelled) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    return this.queue.shift();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function nextChunkWithTimeout<T>(
  iterator: AsyncIterator<T>,
  stream: Pick<Readable, 'destroy'>,
  timeoutMs: number
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stream.destroy();
          reject(new Error(`Voice TTS PCM stream stalled for ${timeoutMs} ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function nextChunkWithSilence<T>(
  iterator: AsyncIterator<T>,
  stream: Pick<Readable, 'destroy'>,
  output: PassThrough,
  timeoutMs: number,
  silenceIntervalMs = PCM_KEEP_ALIVE_INTERVAL_MS
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  let silenceTimer: NodeJS.Timeout | undefined;
  let waitingForDrain = false;
  try {
    return await new Promise<IteratorResult<T>>((resolve, reject) => {
      const next = iterator.next();
      const stopSilence = () => {
        if (silenceTimer) clearInterval(silenceTimer);
        silenceTimer = undefined;
      };
      timer = setTimeout(() => {
        stopSilence();
        stream.destroy();
        reject(new Error(`Voice TTS PCM stream stalled for ${timeoutMs} ms.`));
      }, timeoutMs);
      silenceTimer = setInterval(() => {
        if (waitingForDrain || output.destroyed) return;
        if (!output.write(PCM_KEEP_ALIVE_SILENCE)) {
          waitingForDrain = true;
          void once(output, 'drain').then(
            () => { waitingForDrain = false; },
            () => undefined
          );
        }
      }, silenceIntervalMs);
      next.then(
        (value) => {
          stopSilence();
          resolve(value);
        },
        (error: unknown) => {
          stopSilence();
          reject(error);
        }
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (silenceTimer) clearInterval(silenceTimer);
  }
}

export async function waitForDrainWithTimeout(stream: PassThrough, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(stream, 'drain').then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stream.destroy();
          reject(new Error(`Voice TTS PCM output stalled for ${timeoutMs} ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class SentenceBuffer {
  private remainder = '';

  push(delta: string): string[] {
    this.remainder += delta;
    const ready: string[] = [];
    const matcher = /(.+?[.!?]+(?:["'\]\)]*)?)(?=\s|$)/g;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = matcher.exec(this.remainder))) {
      ready.push(match[1].trim());
      consumed = matcher.lastIndex;
    }
    if (consumed) this.remainder = this.remainder.slice(consumed).trimStart();
    // Do not make a listener wait forever for a model that writes very long
    // clauses without punctuation.
    if (this.remainder.length >= 180) {
      const boundary = this.remainder.lastIndexOf(' ', 160);
      if (boundary > 0) {
        ready.push(this.remainder.slice(0, boundary).trim());
        this.remainder = this.remainder.slice(boundary + 1);
      }
    }
    return ready.filter(Boolean);
  }

  flush(): string[] {
    const final = this.remainder.trim();
    this.remainder = '';
    return final ? [final] : [];
  }
}

type VoiceCapture = {
  pcm: Buffer;
  capturedMs: number;
  noiseFloor: number;
  voicedMs: number;
  averageRms: number;
  peakRms: number;
  discardReason: 'no-confirmed-speech' | 'too-short' | undefined;
};

async function captureSpeakerPcm(
  connection: VoiceConnection,
  userId: string,
  maxPcmBytes: number,
  initialNoiseFloor = VAD_INITIAL_NOISE_FLOOR,
  signal?: AbortSignal
): Promise<VoiceCapture> {
  const opus = connection.receiver.subscribe(userId, {
    // Keep the subscription alive across Discord's short speaking-start/end
    // pulses. The adaptive VAD below owns the conversational endpoint.
    end: { behavior: EndBehaviorType.Manual }
  });
  const captureController = new AbortController();
  let endTimer: NodeJS.Timeout | undefined;
  const closeCapture = () => {
    if (!captureController.signal.aborted) captureController.abort();
  };
  const onSpeakingEnd = (endedUserId: string) => {
    if (endedUserId !== userId || endTimer) return;
    // A Discord speaking-end event can be just a short pause between two
    // sentences. Leave a generous hand-off window; a new start cancels it.
    endTimer = setTimeout(closeCapture, VAD_SPEAKING_END_GRACE_MS);
    endTimer.unref?.();
  };
  const onSpeakingStart = (startedUserId: string) => {
    if (startedUserId !== userId || !endTimer) return;
    clearTimeout(endTimer);
    endTimer = undefined;
  };
  const deadlineTimer = setTimeout(closeCapture, VAD_CAPTURE_DEADLINE_MS);
  deadlineTimer.unref?.();
  signal?.addEventListener('abort', closeCapture, { once: true });
  connection.receiver.speaking.on('end', onSpeakingEnd);
  connection.receiver.speaking.on('start', onSpeakingStart);
  try {
    return await capturePcmWithVad(opus, maxPcmBytes, captureController.signal, initialNoiseFloor);
  } finally {
    clearTimeout(deadlineTimer);
    if (endTimer) clearTimeout(endTimer);
    signal?.removeEventListener('abort', closeCapture);
    connection.receiver.speaking.off('end', onSpeakingEnd);
    connection.receiver.speaking.off('start', onSpeakingStart);
  }
}

async function capturePcmWithVad(opus: Readable, maxPcmBytes: number, signal?: AbortSignal, initialNoiseFloor = VAD_INITIAL_NOISE_FLOOR): Promise<VoiceCapture> {
  const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
  const pcm = opus.pipe(decoder);
  const closeStreams = () => {
    if (!opus.destroyed) opus.destroy();
    if (!decoder.destroyed) decoder.destroy();
  };
  // Discord does not always provide trailing silence packets. When the
  // speaking-end grace timer closes the Opus source, also close the decoder;
  // otherwise its async iterator can remain open and block every later turn.
  const closeDecoder = () => {
    if (!decoder.destroyed && !decoder.writableEnded) decoder.end();
  };
  opus.once('close', closeDecoder);
  signal?.addEventListener('abort', closeStreams, { once: true });
  if (signal?.aborted) closeStreams();
  const captured: Buffer[] = [];
  const onset: Buffer[] = [];
  let totalBytes = 0;
  let onsetMs = 0;
  let voicedMs = 0;
  let silenceMs = 0;
  let capturedMs = 0;
  let hasSpeech = false;
  let noiseFloor = normalizeVadNoiseFloor(initialNoiseFloor);
  let rmsTotal = 0;
  let rmsFrames = 0;
  let peakRms = 0;

  try {
    for await (const chunk of pcm) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const durationMs = (buffer.length / (48_000 * 2 * 2)) * 1_000;
      const rms = frameRms(buffer);
      rmsTotal += rms;
      rmsFrames += 1;
      peakRms = Math.max(peakRms, rms);
      const voiced = isVoiceFrame(rms, noiseFloor);

      if (!hasSpeech) {
        if (!voiced) {
          onset.length = 0;
          onsetMs = 0;
          noiseFloor = updateNoiseFloor(noiseFloor, rms);
          continue;
        }
        onset.push(buffer);
        onsetMs += durationMs;
        if (onsetMs < VAD_START_CONFIRMATION_MS) continue;
        hasSpeech = true;
        captured.push(...onset);
        totalBytes += onset.reduce((total, frame) => total + frame.length, 0);
        capturedMs += onsetMs;
        voicedMs += onsetMs;
        onset.length = 0;
        continue;
      }

      totalBytes += buffer.length;
      capturedMs += durationMs;
      if (totalBytes > maxPcmBytes) throw new Error('Voice utterance exceeded the maximum allowed duration.');
      captured.push(buffer);
      if (voiced) {
        voicedMs += durationMs;
        silenceMs = 0;
      } else {
        silenceMs += durationMs;
        noiseFloor = updateNoiseFloor(noiseFloor, rms);
        const endpointMs = endpointSilenceMs(voicedMs);
        if (silenceMs >= endpointMs) {
          closeStreams();
          break;
        }
      }
      // A microphone held open by fan or game noise cannot keep one request
      // alive forever. It becomes a bounded utterance instead.
      if (capturedMs >= VAD_MAX_UTTERANCE_MS) {
        closeStreams();
        break;
      }
    }
  } catch (error) {
    // Ending a Discord subscription may close the source before Node sees a
    // normal EOF. The PCM accumulated up to that point is still a valid
    // utterance and must continue to STT.
    if (!isExpectedCaptureClose(error, opus)) throw error;
  } finally {
    signal?.removeEventListener('abort', closeStreams);
    opus.off('close', closeDecoder);
    if (!opus.destroyed) opus.destroy();
    if (!pcm.destroyed) pcm.destroy();
    if (!decoder.destroyed) decoder.destroy();
  }

  const averageRms = rmsFrames ? rmsTotal / rmsFrames : 0;
  if (!hasSpeech) {
    return { pcm: Buffer.alloc(0), capturedMs, noiseFloor, voicedMs, averageRms, peakRms, discardReason: 'no-confirmed-speech' };
  }
  if (voicedMs < VAD_MINIMUM_UTTERANCE_MS) {
    return { pcm: Buffer.alloc(0), capturedMs, noiseFloor, voicedMs, averageRms, peakRms, discardReason: 'too-short' };
  }
  return { pcm: Buffer.concat(captured), capturedMs, noiseFloor, voicedMs, averageRms, peakRms, discardReason: undefined };
}

export function isExpectedCaptureClose(error: unknown, opus: Pick<Readable, 'destroyed'>): boolean {
  return opus.destroyed && (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}
export function isLikelyPlaybackEcho(transcript: string, recentAssistantPhrases: readonly string[]): boolean {
  const normalized = normalizePlaybackEchoText(transcript);
  const words = normalized.split(' ').filter(Boolean);
  if (words.length < 3) return false;
  return recentAssistantPhrases.some((phrase) => {
    const candidate = normalizePlaybackEchoText(phrase);
    return candidate.includes(normalized) || normalized.includes(candidate);
  });
}
function normalizePlaybackEchoText(value: string): string {
  return value
    .replace(/^\s*\[[^\]]+\]\s*/u, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function voiceTranscriptionIsConfident(confidence: number | undefined): boolean {
  return confidence === undefined || confidence >= VOICE_MIN_STT_CONFIDENCE;
}

export function voiceReconnectDelayMs(attempt: number): number | undefined {
  return VOICE_RECONNECT_DELAYS_MS[attempt - 1];
}
export function endpointSilenceMs(voicedMs: number): number {
  return voicedMs < VAD_SHORT_UTTERANCE_MS ? VAD_SHORT_SILENCE_MS : VAD_LONG_SILENCE_MS;
}

export function voiceFrameThreshold(noiseFloor: number): number {
  const floor = normalizeVadNoiseFloor(noiseFloor);
  const quietChannelFloor = Math.max(260, Math.min(VAD_MIN_RMS, floor * 1.8));
  return Math.max(quietChannelFloor, Math.min(1_300, floor * 2.25));
}

export function smoothVadNoiseFloor(previous: number, observed: number): number {
  const prior = normalizeVadNoiseFloor(previous);
  const sample = normalizeVadNoiseFloor(observed);
  return Math.round(prior * 0.75 + sample * 0.25);
}

function normalizeVadNoiseFloor(value: number): number {
  if (!Number.isFinite(value)) return VAD_INITIAL_NOISE_FLOOR;
  return Math.max(60, Math.min(900, value));
}

function isVoiceFrame(rms: number, noiseFloor: number): boolean {
  return rms >= voiceFrameThreshold(noiseFloor);
}

function updateNoiseFloor(current: number, rms: number): number {
  return current * 0.9 + Math.min(rms, 1_000) * 0.1;
}

function frameRms(buffer: Buffer): number {
  let sumSquares = 0;
  const samples = Math.floor(buffer.length / 2);
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
}
function logPreview(value: string, maxLength = 500): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  return JSON.stringify(normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength) + '...');
}
function limitVoiceText(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= VOICE_INPUT_MAX_CHARS) return normalized;
  const marker = '\n[... middle omitted to stay within the voice budget ...]\n';
  const available = VOICE_INPUT_MAX_CHARS - marker.length;
  const start = Math.floor(available * 0.4);
  return `${normalized.slice(0, start)}${marker}${normalized.slice(-(available - start))}`;
}
export function isExplicitInterrupt(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /\b(?:wait|stop|hold on|hang on|pause|quiet|be quiet|shut\s*up|shush)\b/u.test(normalized) || /(\uC7A0\uAE50|\uAE30\uB2E4\uB824|\uBA48\uCD94|\uBA48\uCD88|\uC2A4\uD1B1|\uADF8\uB9CC|\uC870\uC6A9\uD788|\uB2E5\uCCD0)/u.test(normalized);
}
function waitForSpeechConfirmation(): Promise<void> {
  return wait(120);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function errorCode(error: unknown): string {
  return messageOf(error).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'unknown_error';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
