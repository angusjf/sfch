import * as fs from "node:fs"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as readline from "node:readline"
import { Readable } from "node:stream"
import { styleText } from "node:util"

const styles = {
    user: ["bold", "cyan"],
    agent: ["bold", "green"],
    reasoning: ["dim", "italic", "gray"],
    toolCall: ["bold", "yellow"],
    toolResult: ["magenta"],
} as const

console.log(
    styleText(
        styles.toolResult,
        `
                  _/_/            _/       single
     _/_/_/    _/        _/_/_/  _/_/_/    file
  _/_/      _/_/_/_/  _/        _/    _/   
     _/_/    _/      _/        _/    _/    coding
_/_/_/      _/        _/_/_/  _/    _/     harness
`,
    ),
)

const file = process.argv[2] || `${randomUUID()}.jsonl`

const readSession = () =>
    fs.existsSync(file)
        ? fs
              .readFileSync(file, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
        : []

for (const message of readSession()) {
    if (message.role === "user") console.log(styleText(styles.user, ">"), message.content)
    if (message.role === "assistant" && message.content)
        console.log(styleText(styles.agent, message.content))
    if (message.tool_calls)
        console.log(
            styleText(
                styles.toolCall,
                `> ${JSON.parse(message.tool_calls[0].function.arguments).command}`,
            ),
        )
    if (message.role === "tool") process.stdout.write(styleText(styles.toolResult, message.content))
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: styleText(styles.user, "> "),
})

rl.prompt()

for await (const line of rl) {
    fs.appendFileSync(file, JSON.stringify({ role: "user", content: line }) + "\n")

    while (true) {
        const resp = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "accounts/fireworks/models/glm-5p3",
                reasoning_effort: "low",
                stream: true,
                parallel_tool_calls: false,
                messages: readSession(),
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "bash",
                            description: "Run a shell command",
                            parameters: {
                                type: "object",
                                properties: { command: { type: "string" } },
                                required: ["command"],
                            },
                        },
                    },
                ],
            }),
        })

        if (!resp.ok) throw Error(await resp.text())

        let answer = ""
        let lineEnded = true
        const toolCall = { id: "", type: "function", function: { name: "", arguments: "" } }

        for await (const line of readline.createInterface({ input: Readable.from(resp.body!) })) {
            if (!line.startsWith("data: ") || line === "data: [DONE]") continue
            const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta || {}
            const reasoning = delta.reasoning_content || ""
            const content = delta.content || ""
            if (reasoning) process.stdout.write(styleText(styles.reasoning, reasoning))
            if (content) process.stdout.write(styleText(styles.agent, content))
            const text = reasoning + content
            if (text) lineEnded = text.endsWith("\n")
            answer += content
            const call = delta.tool_calls?.[0]
            toolCall.id ||= call?.id || ""
            toolCall.function.name ||= call?.function?.name || ""
            toolCall.function.arguments += call?.function?.arguments || ""
        }

        if (!lineEnded) process.stdout.write("\n")

        fs.appendFileSync(
            file,
            JSON.stringify({
                role: "assistant",
                content: answer || null,
                tool_calls: toolCall.id ? [toolCall] : undefined,
            }) + "\n",
        )

        if (toolCall.id) {
            const { command } = JSON.parse(toolCall.function.arguments)
            console.log(styleText(styles.toolCall, `> ${command}`))
            const result = spawnSync(command, { shell: true, encoding: "utf8" })
            const out = result.stdout + result.stderr
            process.stdout.write(styleText(styles.toolResult, out))
            fs.appendFileSync(
                file,
                JSON.stringify({ role: "tool", tool_call_id: toolCall.id, content: out }) + "\n",
            )
        } else break
    }

    rl.prompt()
}

console.log(styleText(["red"], "resume session with sfch " + file))
