import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { logger } from './utils/logger';
 
// This function can be marked `async` if using `await` inside
export function middleware(request: NextRequest) {
    console.log(`Received ${request.method} request to ${request.url} at ${new Date()}`);
    const startTime = Date.now();
    const requestId = request.headers.get('x-request-id');
    const response = NextResponse.next();
    const duration = Date.now() - startTime;
    logger.info({"http.method": request.method, "request.id": requestId }, c
        `${request.method} ${request.url} ${response.status} ${duration}ms request_id=${requestId}`);
    return response;
}
 
// See "Matching Paths" below to learn more
export const config = {
  matcher: '/(.*)',
}