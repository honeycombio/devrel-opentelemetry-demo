"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAnthropicClient = getAnthropicClient;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
let _client = null;
function getAnthropicClient() {
    if (!_client) {
        _client = new sdk_1.default({
            apiKey: process.env.ANTHROPIC_API_KEY,
            maxRetries: 3,
        });
    }
    return _client;
}
