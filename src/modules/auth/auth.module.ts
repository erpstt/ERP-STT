import { AuthController } from './controllers/auth.controller.js';
import { SupabaseAuthRepository } from './repositories/auth.repository.js';
import { AuthService } from './services/auth.service.js';

const service = new AuthService(new SupabaseAuthRepository());
export const authController = new AuthController(service);
