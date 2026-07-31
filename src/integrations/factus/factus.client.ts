import { env } from '../../config/env';
import type { FactusJson, FactusPayload } from './types';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface TokenCache {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class FactusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerDetails?: unknown,
  ) {
    super(message);
  }
}

export class FactusClient {
  private token: TokenCache | null = null;
  private tokenRequest: Promise<string> | null = null;

  private assertConfigured() {
    const missing = [
      ['FACTUS_URL', env.factus.url],
      ['FACTUS_CLIENT_ID', env.factus.clientId],
      ['FACTUS_CLIENT_SECRET', env.factus.clientSecret],
      ['FACTUS_USERNAME', env.factus.username],
      ['FACTUS_PASSWORD', env.factus.password],
    ].filter(([, value]) => !value);

    if (!env.factus.enabled || missing.length > 0) {
      throw new FactusError(
        env.factus.enabled
          ? `Factus no está configurado: ${missing.map(([name]) => name).join(', ')}`
          : 'La integración con Factus está deshabilitada',
        503,
      );
    }
  }
  private async fetchJson<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.factus.timeoutMs);

    try {
      const response = await fetch(`${env.factus.url}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Accept: 'application/json', ...init.headers },
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { message: text.slice(0, 500) };
        }
      }
      if (!response.ok) {
        throw new FactusError(`Factus respondió HTTP ${response.status}`, response.status, body);
      }
      return body as T;
    } catch (error) {
      if (error instanceof FactusError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new FactusError('Factus no respondió dentro del tiempo límite', 504);
      }
      throw new FactusError('No fue posible conectar con Factus', 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestToken(grantType: 'password' | 'refresh_token'): Promise<string> {
    this.assertConfigured();
    const form = new URLSearchParams({
      grant_type: grantType,
      client_id: env.factus.clientId,
      client_secret: env.factus.clientSecret,
    });
    if (grantType === 'password') {
      form.set('username', env.factus.username);
      form.set('password', env.factus.password);
    } else if (this.token?.refreshToken) {
      form.set('refresh_token', this.token.refreshToken);
    } else {
      return this.requestToken('password');
    }

    const data = await this.fetchJson<TokenResponse>('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!data.access_token || !data.expires_in) {
      throw new FactusError('Factus devolvió un token inválido', 502);
    }
    this.token = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + Math.max(data.expires_in - 60, 1) * 1000,
    };
    return data.access_token;
  }

  private async accessToken(): Promise<string> {
    this.assertConfigured();
    if (this.token && Date.now() < this.token.expiresAt) return this.token.accessToken;
    if (!this.tokenRequest) {
      const grant = this.token?.refreshToken ? 'refresh_token' : 'password';
      this.tokenRequest = this.requestToken(grant).catch(async (error) => {
        if (grant === 'refresh_token') {
          this.token = null;
          return this.requestToken('password');
        }
        throw error;
      });
    }
    try {
      return await this.tokenRequest;
    } finally {
      this.tokenRequest = null;
    }
  }

  private async authorized<T>(path: string, init: RequestInit, retry = true): Promise<T> {
    const token = await this.accessToken();
    try {
      return await this.fetchJson<T>(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      });
    } catch (error) {
      if (retry && error instanceof FactusError && error.status === 401) {
        this.token = null;
        return this.authorized<T>(path, init, false);
      }
      throw error;
    }
  }

  createInvoice(payload: FactusPayload): Promise<FactusJson> {
    return this.authorized('/v2/bills/validate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  getInvoice(number: string): Promise<FactusJson> {
    return this.authorized(`/v2/bills/show/${encodeURIComponent(number)}`, { method: 'GET' });
  }

  listInvoices(filters: { identification?: string; number?: string; page?: number }) {
    const query = new URLSearchParams();
    if (filters.identification) query.set('identification', filters.identification);
    if (filters.number) query.set('number', filters.number);
    if (filters.page) query.set('page', String(filters.page));
    const suffix = query.size > 0 ? `?${query}` : '';
    return this.authorized<FactusJson>(`/v2/bills${suffix}`, { method: 'GET' });
  }
}

export const factusClient = new FactusClient();