/**
 * Ambient module declaration for z-ai-web-dev-sdk.
 *
 * This allows `tsc --noEmit` to pass even when the SDK is NOT installed
 * (it's an optional dependency). The actual types ship with the package
 * when installed; this declaration provides a minimal fallback so the
 * compiler doesn't error on dynamic imports or type references.
 *
 * The SDK is loaded dynamically via `chismoso/src/providers/zai-loader.ts`
 * and `src/app/api/chat/route.ts` — never imported statically.
 */
declare module 'z-ai-web-dev-sdk' {
  interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
  }
  interface CreateChatCompletionBody {
    model?: string;
    messages: ChatMessage[];
    stream?: boolean;
    thinking?: { type: 'enabled' | 'disabled' };
    [key: string]: any;
  }
  interface SearchFunctionArgs {
    query: string;
    num?: number;
    recency_days?: number;
  }
  interface SearchFunctionResultItem {
    url: string;
    name: string;
    snippet: string;
    host_name: string;
    rank: number;
    date: string;
    favicon: string;
  }
  interface PageReaderFunctionArgs {
    url: string;
  }
  interface PageReaderFunctionResult {
    code: number;
    data: {
      html: string;
      publishedTime?: string;
      title: string;
      url: string;
      usage: { tokens: number };
    };
    meta: { usage: { tokens: number } };
    status: number;
  }

  interface ZAI {
    chat: {
      completions: {
        create: (body: CreateChatCompletionBody) => Promise<any>;
        createVision: (body: any) => Promise<any>;
      };
    };
    functions: {
      invoke: <T extends string>(name: T, args: any) => Promise<any>;
    };
  }

  const ZAI: {
    create: () => Promise<ZAI>;
  };
  export default ZAI;
}
