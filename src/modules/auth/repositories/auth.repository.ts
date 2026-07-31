import type { LoginDto } from '../dto/login.dto.js';

export interface AuthRepository {
  signIn(input: LoginDto): Promise<{ accessToken: string; user: { name: string; email: string } }>;
}

export class DemoAuthRepository implements AuthRepository {
  async signIn(input: LoginDto) {
    return {
      accessToken: `demo.${Buffer.from(input.email).toString('base64url')}`,
      user: { name: input.email.split('@')[0], email: input.email }
    };
  }
}
