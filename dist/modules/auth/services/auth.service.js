import { isValidPassword } from '../../../shared/services/password.service.js';
export class AuthService {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async signIn(input) {
        if (!/^\S+@\S+\.\S+$/.test(input.email))
            throw new Error('Ingrese un correo electrónico válido.');
        if (!isValidPassword(input.password))
            throw new Error('La contraseña debe tener al menos 6 caracteres.');
        return this.repository.signIn(input);
    }
}
