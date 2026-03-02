Implementing an agent in devrel demos

I need to create a customer service chat agent exposed as a web service in this demo application. Major features:

- hook in to the product page's "Ask AI About this Project" area and bypass the existing llm demo (which isn't llm at all, just smoke and mirrors - just hide the three prefab question buttons in that section).
- a subproject named chatbot
  - this subproject is exposed on the host as /chat
  - the subproject accepts requests and returns responses synchronously from the endpoint /chat/question
  - the subproject runs an anthropic agent that
    - takes a customer service chat, focuses on questions about the product catalog (which it can fetch via /products as JSON data), and answers them
    - does not answer any other questions, just replies with "AI Response: Sorry, I'm not able to answer that question."

- the agents should be:
  - a supervisor agent that coordinates the chat flow
  - a sub-agent to determine the whether the question can be answered by the application
  - a sub-agent do call the API endpoint and gather information about the product
  - a sub-agent to report the answer back to the client

- I need to
  - pass the ANTHROPIC_API_KEY in from an env var to the app
  - instrument the chatbot using the same techniques as in /Users/kenrimple/code/honeycombio/ai-o11y-fedex - exporting as telemetry along with everything else in this project with the service name 'chatbot'. Honor trace propagation into the chat so a question from the UI will be tied together with the chatbot in a single trace.
  - only execute the chatbot if
    - I manually enable it with /chat/demo-enable (disable with /chat/demo-disable)
    - the ANTHROPIC_API_KEY is installed - otherwise report "The Chatbot is Unavailable"
