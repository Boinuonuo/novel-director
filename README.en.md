<p align="center"><img src="./assets/icon.png" alt="Novel Director" width="96"></p>

<h1 align="center">Novel Director</h1>

<p align="center">A desktop client for writing long novels together with AI</p>

<p align="center"><a href="./README.md">简体中文</a> · English</p>

One conversation is one novel. Each turn the AI writes a chapter and ends it with two or three directions. Pick one, combine several, add details, or write your own, and the story follows your reply.

Over hundreds of thousands of words, an ordinary chat forgets the setting, drops foreshadowing and gets numbers wrong. Novel Director has a background model keep the books, so the writing model can just write.

## Features

**No lorebook to maintain.** Characters (personality, way of speaking, current state), terms, foreshadowing and the story so far are organised in the background. You don't write a world book up front or patch it as you go.

**Only what has settled is recorded.** A chapter is recorded about two replies after it is written. Directions you rejected, ignored or rewrote are not kept, so things that never happened in the story don't leak into the setting.

**Numbers stay exact.** Money, levels and power are tracked chapter by chapter as changes. A change just written counts toward the next chapter's context at once. Where the prose and the ledger disagree, it is flagged and you choose which one stands. Nothing is quietly overwritten.

**A coherent world.** An optional world model works through how prices, ranks and power relate. Values it works out are marked as inferred, with the reasoning behind them.

**The books are yours.** Every entry can be edited or deleted, and deleted entries can be restored. What you change, the background won't change back.

**Steady over a long story.** Context is assembled within a budget, and old foreshadowing is recalled together with its original text. The chapter directory collapses, and a click jumps to that chapter.

**Writing experience.** Dialogue is coloured to the theme and set apart from narration. Before you start and between chapters you can talk settings and direction over with the narrator, and what you settle there is recorded too.

## Models

The writer, the background model and the world model are each chosen separately. A common setup is a model with good prose for the chapters and a cheap one for the books. Without a background model it works as an ordinary AI chat client.

It supports DeepSeek, Claude, OpenAI, Gemini, Qwen, Moonshot, Zhipu, Volcengine, SiliconFlow, OpenRouter, Ollama, LM Studio and more, and you can add any OpenAI-compatible service. You enter your own API keys.

## Data

Your novels, settings and API keys stay on your computer. There are no accounts, no analytics and no error reporting. Apart from the model services you configure and web search when you turn it on, it connects to no server.

## Run

There are no prebuilt installers yet, so run it from source. You need Node.js 22 and pnpm 10.

```bash
pnpm install
pnpm start
```

Build an installer (Windows, macOS, Linux):

```bash
pnpm package
```

## License

GPL-3.0, see [LICENSE](./LICENSE). Modified from [Chatbox Community Edition](https://github.com/chatboxai/chatbox); see [NOTICE](./NOTICE).
