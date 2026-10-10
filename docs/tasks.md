First use-case - try to convert to knowledge bots (my own knowledge agents)

## Later
* A model tool that creates schedules (and a generalized approach to create "self" tools - so we could expose more internal functionality to the LLM)
* A real user identity, and an admin mode on top of it. The web credential stays a door.
* Per-user MCP sessions keyed by bot and user. Server configuration stays shared.
* Communication hub between bots - perhaps define a "family" so all bots share something within the family and can communicate - todo: define what else is shared.

## Big effort
* Stateless, cloud-native - run over cloudflare eco-system: (needs design and plan)
    * each bot as a durable object, with its own schedules, etc... 
    * Main controller app and UI running over workers / pages
    * Local mode can still be supported using celld or similar
* Support "bot apps" - a bot can craft a "support app" for itself that exposes a UI to the user. the idea is simple apps that serve a purpose for interfacing with the user. Main plan is to use "json-render" - for fast iterations. backend - TBD; maybe after moving to cloudflare eco-system, we could use it as worker / its own function over durable objects... 
