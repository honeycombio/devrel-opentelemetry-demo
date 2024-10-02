import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
 
// This function can be marked `async` if using `await` inside
export function middleware(request: NextRequest) {
    console.log(`Received ${request.method} request to ${request.url} at ${new Date()}`);
    const response = NextResponse.next();
    console.log(`Responding to ${request.url} status ${response.status}, ${request.headers.get('x-request-id')}`);
    return response;
}
 
// See "Matching Paths" below to learn more
export const config = {
  matcher: '/(.*)',
}