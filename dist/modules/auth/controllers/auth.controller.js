export class AuthController {
    service;
    constructor(service) {
        this.service = service;
    }
    signIn(body) { return this.service.signIn(body); }
}
