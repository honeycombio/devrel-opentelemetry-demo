"use strict";
/**
 * Shared types and constants for LLM evaluation scorers.
 * Always uses OpenAI gpt-4o as the judge model.
 *
 * The autoevals library reads OPENAI_API_KEY from the environment automatically.
 * We pass EVAL_MODEL to each scorer call to ensure gpt-4o is used.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVAL_MODEL = void 0;
exports.EVAL_MODEL = 'gpt-4o';
