import type { LoginDto } from '../dto/login.dto.js';
import type { AuthService } from '../services/auth.service.js';

export class AuthController {
  constructor(private readonly service: AuthService) {}
  signIn(body: LoginDto) { return this.service.signIn(body); }
}
