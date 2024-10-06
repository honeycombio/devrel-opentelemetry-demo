import { NextApiRequest, NextApiResponse } from 'next';
import { trace,context, SpanStatusCode } from '@opentelemetry/api';
import InstrumentationMiddleware from '../../utils/telemetry/InstrumentationMiddleware';

// Assuming you've set up a tracer provider elsewhere
const tracer = trace.getTracer('memory-allocation-demo');

// Global variable to store allocated memory
const allocatedMemories: any[] = [];

const MAX_MEMORY_ALLOCATION = 300 * 1024 * 1024; // 300Mb max allocation (pod is allocated 250Mb)
const DEFAULT_ALLOCATION_SIZE = 10 * 1024 * 1024; // 10MB default allocation
const SIZE_OF_FILLER = 4; // 4 bytes per character
const CHUNK_SIZE = 1024 * 1024 / SIZE_OF_FILLER; // 1MB chunks, where 🤐 is 4b, and that's what I'm filling the array with.

function getCurrentAllocation() {
    return allocatedMemories.length * CHUNK_SIZE * SIZE_OF_FILLER;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  return tracer.startActiveSpan('memory-allocation-handler', async (span) => {
    try {
      if (req.method !== 'GET') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Method not allowed' });
        span.end();
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const retentionTime = Math.min(parseInt(req.query.retentionTime as string, 10) || 60, 3000); // Max 50 minutes
      const allocationSize = Math.min(
        parseInt(req.query.allocationSize as string, 10) || DEFAULT_ALLOCATION_SIZE,
        MAX_MEMORY_ALLOCATION - getCurrentAllocation()
      );

      span.setAttributes({
        'retentionTime': retentionTime,
        'allocationSize': allocationSize,
        'currentAllocation': getCurrentAllocation(),
      });

      // Allocate memory
      const numChunks = Math.floor(allocationSize / CHUNK_SIZE);
      for (let i = 0; i < numChunks; i++) {
        allocatedMemories.push(new Array(CHUNK_SIZE).fill('🤐'));
      }

      // Log memory usage
     const memoryUsage = recordMemoryUsage();

      const allocatingSpanContext = context.active();
      // Schedule memory release
      setTimeout(() => {
        tracer.startActiveSpan('release-memory', { }, allocatingSpanContext, (releaseSpan) => {
          allocatedMemories.splice(-numChunks);  // Remove the chunks we added
          global?.gc && global.gc(); // Force garbage collection if available
          
          recordMemoryUsage();
          releaseSpan.setAttributes({
            'event': 'memory-released',
            'retentionTime': retentionTime,
          });
          releaseSpan.end();
        });
      }, retentionTime * 1000);

      span.setStatus({ code: SpanStatusCode.OK });
      res.status(200).json({ 
        message: 'Memory allocated', 
        retentionTime, 
        allocationSize,
        currentAllocation: getCurrentAllocation(),
        memoryUsage
      });
    } catch (error) {
      console.error('Error allocating memory:', error);
      span.recordException(error as Error);
      span.setStatus({ 
        code: SpanStatusCode.ERROR, 
        message: 'Error allocating memory'
      });
      res.status(500).json({ error: 'Error allocating memory' });
    } finally {
      span.end();
    }
  });
}

function recordMemoryUsage() {
    const span = trace.getActiveSpan()
     // Log memory usage
     const memoryUsage = process.memoryUsage();
     span?.setAttributes({
       'memoryUsage.rss': memoryUsage.rss,
       'memoryUsage.heapTotal': memoryUsage.heapTotal,
       'memoryUsage.heapUsed': memoryUsage.heapUsed,
       'memoryUsage.external': memoryUsage.external,
     });
     return memoryUsage;
}

export default InstrumentationMiddleware(handler);