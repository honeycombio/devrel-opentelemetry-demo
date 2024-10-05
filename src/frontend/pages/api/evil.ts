import { NextApiRequest, NextApiResponse } from 'next';
import { trace,context, SpanStatusCode } from '@opentelemetry/api';

// Assuming you've set up a tracer provider elsewhere
const tracer = trace.getTracer('memory-allocation-demo');

// Global variable to store allocated memory
const allocatedMemories: Array<Buffer | null> = [];
let memoriesAllocated = 0;

const MAX_MEMORY_ALLOCATION = 100 * 1024 * 1024 * 1024; // 100GB max allocation
const DEFAULT_ALLOCATION_SIZE = 100 * 1024 * 1024; // 100MB default allocation

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return tracer.startActiveSpan('memory-allocation-handler', async (span) => {
    try {
      if (req.method !== 'GET') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Method not allowed' });
        span.end();
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const retentionTime = Math.min(parseInt(req.query.retentionTime as string, 10) || 60, 300); // Max 5 minutes
      const allocationSize = Math.min(
        parseInt(req.query.allocationSize as string, 10) || DEFAULT_ALLOCATION_SIZE,
        MAX_MEMORY_ALLOCATION
      );

      span.setAttributes({
        'retentionTime': retentionTime,
        'allocationSize': allocationSize,
      });

      // Allocate memory
      const iMemoryAllocation = memoriesAllocated++;
      allocatedMemories[iMemoryAllocation] = Buffer.alloc(allocationSize);

      // Log memory usage
     const memoryUsage = recordMemoryUsage();

      const allocatingSpanContext = context.active();
      // Schedule memory release
      setTimeout(() => {
        tracer.startActiveSpan('release-memory', { }, allocatingSpanContext, (releaseSpan) => {
          if (allocatedMemories[iMemoryAllocation]) {
            allocatedMemories[iMemoryAllocation] = null;
          }
          console.log(`Memory released after ${retentionTime} seconds`);
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
     console.log('Memory usage:', memoryUsage);
     span?.setAttributes({
       'memoryUsage.rss': memoryUsage.rss,
       'memoryUsage.heapTotal': memoryUsage.heapTotal,
       'memoryUsage.heapUsed': memoryUsage.heapUsed,
       'memoryUsage.external': memoryUsage.external,
     });
     return memoryUsage;
}