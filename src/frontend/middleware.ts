import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { logger } from './utils/logger';

// This function can be marked `async` if using `await` inside
export function middleware(request: NextRequest) {
    const startTime = Date.now();
    const requestId = request.headers.get('x-request-id');
    const response = NextResponse.next();
    const duration = Date.now() - startTime;
    logger.info(JSON.stringify({
      "timestamp": new Date().toISOString(),
      "http.method": request.method, 
        "request.id": requestId, 
        "http.url": request.url, 
        "http.status": response.status, 
        "duration_ms": duration}));
    return response;
}
 
// See "Matching Paths" below to learn more
export const config = {
  matcher: '/(.*)',
}