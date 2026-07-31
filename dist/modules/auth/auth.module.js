import { AuthController } from './controllers/auth.controller.js';
import { DemoAuthRepository } from './repositories/auth.repository.js';
import { AuthService } from './services/auth.service.js';
const service = new AuthService(new DemoAuthRepository());
export const authController = new AuthController(service);
