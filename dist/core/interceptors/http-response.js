export function json(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
}
export function error(response, status, message) {
    json(response, status, { error: { message, status } });
}
