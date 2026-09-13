import OpenAI from "openai";
import type { LlmClient, LlmCompletion } from "../interfaces/llm-client.interface";

const AI_MODEL = "gpt-4o-mini";

/**
 * `LlmClient` over OpenAI.
 *
 * The client is created on first use rather than at construction, so composing the
 * application does not require `OPENAI_API_KEY` to be set — the rest of the product
 * runs fine without AI configured, and it should not fail to boot over it.
 */
export class OpenAiLlmClient implements LlmClient {
  private client: OpenAI | null = null;

  private openai(): OpenAI {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not configured");
    if (!this.client) this.client = new OpenAI({ apiKey: key });
    return this.client;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<LlmCompletion> {
    const completion = await this.openai().chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      // Low but not zero: the task is near-deterministic translation, and the worked
      // examples in the domain prompts should dominate.
      temperature: 0.1,
      max_tokens: 800,
    });

    return {
      content: completion.choices[0]?.message?.content ?? "",
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    };
  }

  async classify(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.openai().chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 10,
      temperature: 0,
    });
    return response.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
  }
}
