export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  sid: string;
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  jti: string;
  exp: number;
}


export interface AuthContext {
  userId: string;
  organizationId: string;
  sessionId: string;
  roleIds: string[];
  permissions: string[];
}

export interface SessionMeta {
  userAgent?: string;
  ipAddress?: string;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  keepSignedIn: boolean;
}
