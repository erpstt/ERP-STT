import { isValidPassword } from '../../../shared/services/password.service.js';
import type { LoginDto } from '../dto/login.dto.js';
import type { AuthRepository } from '../repositories/auth.repository.js';

export class AuthService {
  constructor(private readonly repository: AuthRepository) {}
  async signIn(input: LoginDto, ipAddress?: string | null) {
    if (!/^\S+@\S+\.\S+$/.test(input.email)) throw new Error('Ingrese un correo electrónico válido.');
    if (!isValidPassword(input.password)) throw new Error('La contraseña debe tener al menos 6 caracteres.');
    return this.repository.signIn(input, ipAddress);
  }
}
