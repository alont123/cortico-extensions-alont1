import { WebSocket, WebSocketServer, type WebSocket as WS } from 'ws';
import type { Logger } from 'cortico/core/types.ts';
import type { OneBotMessage, QQIdentity } from './types.ts';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DriverOptions {
  mode: 'reverse' | 'forward';
  wsUrl: string;
  wsHost: string;
  wsPort: number;
  wsPath: string;
  token: string;
  log: Logger;
  /** 收到 OneBot 事件（post_type 帧）时回调。 */
  onEvent: (ev: OneBotMessage) => void;
  /** 连接状态变化：true=已连接至少一条；false=全部断开。 */
  onConnectionChange?: (connected: boolean) => void;
}

/**
 * OneBot v11 传输层。
 * - reverse：本扩展开 WebSocketServer，等 NapCat 反向连入（fat-fish 风格）。
 * - forward：本扩展作为客户端连到 NapCat 暴露的 wsUrl（内置 world 风格）。
 * 两种模式共用同一帧处理：带 echo 的是 API 回包，带 post_type 的是事件。
 */
/**
 * 从 `get_forward_msg` 的响应里挑出节点。
 *
 * 形状各实现不一样，都认：NapCat 回 `{ messages: [...] }`（对象），部分实现回数组、
 * 每项再裹一层 `{ data: ... }`。只认数组会把整个转发丢成空——那正是"她点不开转发"的原因。
 */
export function pickForwardNodes(raw: unknown): OneBotMessage[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages)
      ? (raw as { messages: unknown[] }).messages
      : [];
  const out: OneBotMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const wrapped = item as { data?: unknown; message?: unknown };
    const node = wrapped.message === undefined && wrapped.data && typeof wrapped.data === 'object'
      ? (wrapped.data as OneBotMessage)
      : (item as OneBotMessage);
    out.push(node);
  }
  return out;
}

export class OneBotDriver {
  private readonly opts: DriverOptions;
  private server: WebSocketServer | null = null;
  private client: WS | null = null;
  private readonly sockets = new Set<WS>();
  private active: WS | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private echoSeq = 0;
  private stopped = false;
  /** 正向（forward）模式断线重连退避计时器与当前延迟（指数退避，上限 30s）。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  private reconnectDelay = 1000;

  constructor(opts: DriverOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.opts.mode === 'reverse') {
      await this.startReverse();
    } else {
      await this.startForward();
    }
  }

  private startReverse(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { wsHost, wsPort, wsPath } = this.opts;
      let server: WebSocketServer;
      try {
        server = new WebSocketServer({ host: wsHost, port: wsPort, path: wsPath || undefined });
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.server = server;
      server.on('listening', () => {
        this.opts.log.info('反向 WS 服务端已监听', { host: wsHost, port: wsPort, path: wsPath });
        resolve();
      });
      server.on('error', (err) => {
        this.opts.log.error('反向 WS 服务端错误', { err: String(err) });
        if (!this.stopped) reject(err as Error);
      });
      server.on('connection', (socket, req) => this.onClientConnect(socket, req));
    });
  }

  private onClientConnect(socket: WS, req: { url?: string }): void {
    const url = req.url ?? '';
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const token = query.get('access_token') ?? query.get('token') ?? '';
    if (this.opts.token && token !== this.opts.token) {
      this.opts.log.warn('接入 Token 不匹配，拒绝连接', { url });
      socket.close(1008, 'invalid token');
      return;
    }
    this.sockets.add(socket);
    this.active = socket;
    this.opts.log.info('NapCat 已反向连入', { total: this.sockets.size });
    this.opts.onConnectionChange?.(true);
    socket.on('message', (data) => this.onFrame(data.toString()));
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.active === socket) this.active = this.sockets.size ? Array.from(this.sockets).pop() ?? null : null;
      this.opts.log.info('NapCat 连接断开', { remaining: this.sockets.size });
      if (this.sockets.size === 0) this.opts.onConnectionChange?.(false);
    });
    socket.on('error', (err) => this.opts.log.warn('socket 错误', { err: String(err) }));
    void this.refreshIdentity();
  }

  /**
   * 正向（forward）模式：启动即返回，连接在后台进行；任一次失败/断开都会按指数退避自动重连
   * （1s → 2s → 4s … 上限 30s，连上后重置）。这样本扩展即使 NapCat 暂时离线也不会整段启动失败。
   */
  private startForward(): Promise<void> {
    this.connectForward();
    return Promise.resolve();
  }

  private connectForward(): void {
    if (this.stopped) return;
    let url = this.opts.wsUrl;
    if (this.opts.token && !/access_token=/.test(url)) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}access_token=${encodeURIComponent(this.opts.token)}`;
    }
    const client = new WebSocket(url);
    this.client = client;
    const onOpen = () => {
      this.sockets.add(client);
      this.active = client;
      this.reconnectDelay = 1000; // 连上成功，重置退避
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      this.opts.log.info('已正向连入 NapCat', { url });
      this.opts.onConnectionChange?.(true);
      client.on('message', (data) => this.onFrame(data.toString()));
      client.on('close', () => {
        this.sockets.delete(client);
        if (this.active === client) this.active = null;
        this.opts.log.warn('NapCat 连接关闭，将重连', {});
        if (this.sockets.size === 0) this.opts.onConnectionChange?.(false);
        this.client = null;
        this.scheduleReconnect();
      });
      client.on('error', (err) => this.opts.log.warn('正向连接错误', { err: String(err) }));
      void this.refreshIdentity();
    };
    client.on('open', onOpen);
    client.on('error', (err) => {
      this.opts.log.error('正向连接失败，将重连', { err: String(err) });
      this.client = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    this.opts.log.info('正向连接重连排程', { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectForward();
    }, delay);
  }

  private onFrame(raw: string): void {
    let msg: OneBotMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.echo !== undefined) {
      const pending = this.pending.get(String(msg.echo));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(msg.echo));
        if (msg.status === 'failed') {
          pending.reject(new Error(msg.message !== undefined ? String(msg.message) : 'API failed'));
        } else {
          pending.resolve(msg.data);
        }
      }
      return;
    }
    if (msg.post_type) {
      this.opts.onEvent(msg);
    }
  }

  /** 调用 OneBot API，回包按 echo 关联。 */
  callApi<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.active;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('未连接到 NapCat'));
    }
    const echo = `c${(++this.echoSeq).toString(36)}_${Date.now().toString(36)}`;
    const payload = { action, params, echo };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`API ${action} 超时`));
      }, 30000);
      this.pending.set(echo, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        socket.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(e as Error);
      }
    });
  }

  /** 拉取登录身份与群列表，构建 QQIdentity。 */
  async refreshIdentity(): Promise<QQIdentity> {
    const login = (await this.callApi<{ user_id: number; nickname: string }>('get_login_info')) ?? {
      user_id: 0,
      nickname: '',
    };
    const groupsRaw = (await this.callApi<Array<{ group_id: number; group_name: string }>>('get_group_list')) ?? [];
    const groups = new Map<number, string>();
    for (const g of groupsRaw) groups.set(g.group_id, g.group_name);
    // 好友列表：私聊对方的名字。取不到不影响身份——号码永远是对的，名字只是让读数和事件行好认人。
    const knownPeers = new Map<number, { nickname: string; card?: string }>();
    const nicknameConflicts = new Set<number>();
    try {
      const friends = (await this.callApi<Array<{ user_id: number; nickname: string }>>('get_friend_list')) ?? [];
      const seen = new Map<string, number>();
      for (const f of friends) {
        const nickname = f.nickname || String(f.user_id);
        knownPeers.set(f.user_id, { nickname });
        const prev = seen.get(nickname);
        if (prev !== undefined) {
          // 同名的人靠号码区分：标记出来，别的地方要显示名字时能带上号码。
          nicknameConflicts.add(prev);
          nicknameConflicts.add(f.user_id);
        } else seen.set(nickname, f.user_id);
      }
    } catch { /* 拿不到好友列表就只用号码 */ }
    return {
      selfId: login.user_id,
      nickname: login.nickname,
      groups,
      knownPeers,
      nicknameConflicts,
      loadedAt: Date.now(),
    };
  }

  async getMemberInfo(groupId: number, userId: number): Promise<{ nickname: string; card?: string; role?: string; title?: string } | null> {
    try {
      const r = await this.callApi<{ nickname: string; card?: string; role?: string; title?: string }>('get_group_member_info', {
        group_id: groupId,
        user_id: userId,
      });
      return r ?? null;
    } catch {
      return null;
    }
  }

  /** 整个群的成员名单。启动时拉一次：`@名字` 认人、私聊标签都要靠它。 */
  async getGroupMemberList(groupId: number): Promise<Array<{ userId: number; name: string; card?: string; role?: string; title?: string }>> {
    try {
      const r = await this.callApi<Array<{ user_id: number; nickname?: string; card?: string; role?: string; title?: string }>>(
        'get_group_member_list',
        { group_id: groupId },
      );
      if (!Array.isArray(r)) return [];
      return r
        .map((m) => ({
          userId: Number(m.user_id),
          name: m.card || m.nickname || String(m.user_id),
          card: m.card,
          role: m.role,
          title: m.title,
        }))
        .filter((m) => Number.isFinite(m.userId) && m.userId > 0);
    } catch {
      return [];
    }
  }

  async getForwardMessages(forwardId: string, limit: number): Promise<OneBotMessage[]> {
    try {
      const r = await this.callApi<unknown>('get_forward_msg', { id: forwardId });
      return pickForwardNodes(r).slice(0, limit);
    } catch (err) {
      this.opts.log.warn('展开合并转发失败', { err: String(err), forwardId });
      return [];
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('driver 已停止'));
    }
    this.pending.clear();
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    this.active = null;
    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}
