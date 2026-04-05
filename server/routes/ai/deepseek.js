const axios = require('axios');
const { AI_TOOLS, executeTool } = require('./tools');

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// Helper: call DeepSeek API
async function callDeepSeek(systemPrompt, userMessage, maxTokens = 1500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data.choices[0].message.content;
}

// Helper: call DeepSeek API with streaming
async function callDeepSeekStream(systemPrompt, userMessage, maxTokens = 2500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const response = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    responseType: 'stream'
  });

  return response.data;
}

// Helper: stream a DeepSeek response to client via SSE while collecting full content
// Returns { content, toolCalls }. If streaming to client, sends each content chunk as SSE.
function collectAndStreamResponse(stream, res) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let content = '';
    let toolCalls = [];

    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;

        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            content += delta.content;
            // Stream content chunk to client in real time
            if (res) {
              const sseData = { choices: [{ delta: { content: delta.content } }] };
              res.write(`data: ${JSON.stringify(sseData)}\n\n`);
            }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tc.id || '',
                  type: 'function',
                  function: { name: '', arguments: '' }
                };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {
          // skip malformed
        }
      }
    });

    stream.on('end', () => {
      toolCalls = toolCalls.filter(Boolean);
      resolve({ content, toolCalls });
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

// Non-streaming tool call loop: sends request, executes tool calls, repeats up to 5 rounds
async function callDeepSeekWithTools(systemPrompt, userMessage, userId, maxTokens = 2500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const requestBody = {
      model: 'deepseek-chat',
      messages,
      temperature: 0.7,
      max_tokens: maxTokens
    };

    // Only add tools on first few rounds (stop if we're on last round)
    if (round < MAX_ROUNDS - 1) {
      requestBody.tools = AI_TOOLS;
    }

    const response = await axios.post(DEEPSEEK_URL, requestBody, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const choice = response.data.choices[0];
    const assistantMessage = choice.message;

    // If no tool calls — return the text content
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return assistantMessage.content;
    }

    // Add assistant message with tool calls to history
    messages.push(assistantMessage);

    // Execute each tool call and add results
    for (const toolCall of assistantMessage.tool_calls) {
      let args = {};
      try {
        args = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments || {};
      } catch { args = {}; }

      let result;
      try {
        result = await executeTool(userId, toolCall.function.name, args);
      } catch (err) {
        result = { error: `Tool execution failed: ${err.message}` };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }
  }

  // If we exhausted rounds, make one final call without tools
  const finalResponse = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return finalResponse.data.choices[0].message.content;
}

// Streaming tool call loop: buffers tool rounds, streams final text response in real time
async function callDeepSeekStreamWithTools(systemPrompt, userMessage, userId, res, maxTokens = 2500, chatHistory = []) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory,
    { role: 'user', content: userMessage }
  ];

  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const requestBody = {
      model: 'deepseek-chat',
      messages,
      temperature: 0.7,
      max_tokens: maxTokens,
      stream: true
    };

    if (round < MAX_ROUNDS - 1) {
      requestBody.tools = AI_TOOLS;
    }

    const response = await axios.post(DEEPSEEK_URL, requestBody, {
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    // Always stream to client in real time — if tool calls arrive, content is usually empty
    // and we'll send a thinking indicator after
    const { content, toolCalls } = await collectAndStreamResponse(response.data, res);

    // No tool calls — this is the final response (already streamed to client)
    if (toolCalls.length === 0) {
      return content;
    }

    // Tool calls found — send thinking indicator to client
    res.write(`data: ${JSON.stringify({ thinking: true })}\n\n`);

    // Add assistant message with tool calls
    const assistantMsg = { role: 'assistant', content: content || null, tool_calls: toolCalls };
    messages.push(assistantMsg);

    // Execute tool calls
    for (const toolCall of toolCalls) {
      let args = {};
      try {
        args = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments || {};
      } catch { args = {}; }

      let result;
      try {
        result = await executeTool(userId, toolCall.function.name, args);
      } catch (err) {
        result = { error: `Tool execution failed: ${err.message}` };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
    }
  }

  // Final call without tools — stream directly to client
  const finalResponse = await axios.post(DEEPSEEK_URL, {
    model: 'deepseek-chat',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
    stream: true
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    responseType: 'stream'
  });

  const { content } = await collectAndStreamResponse(finalResponse.data, res);
  return content;
}

module.exports = {
  callDeepSeek,
  callDeepSeekStream,
  callDeepSeekWithTools,
  callDeepSeekStreamWithTools
};
