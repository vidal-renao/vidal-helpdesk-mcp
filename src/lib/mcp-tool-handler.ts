import { ZodError, type ZodTypeAny, type z } from "zod";

type McpToolResponse = {
  content: Array<{ type: "text"; text: string }>;
};

export function createValidatedToolHandler<TSchema extends ZodTypeAny>(
  schema: TSchema,
  handler: (input: z.infer<TSchema>) => Promise<string>
) {
  return async (input: unknown): Promise<McpToolResponse> => {
    try {
      const parsedInput = schema.parse(input);
      return {
        content: [{ type: "text", text: await handler(parsedInput) }],
      };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "Invalid tool input",
                issues: error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  code: issue.code,
                  message: issue.message,
                })),
              }),
            },
          ],
        };
      }

      throw error;
    }
  };
}
