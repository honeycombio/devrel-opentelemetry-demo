Goal:

- Expand chatbot service to collect user feedback on its responses. Send the user feedback as a new span on the trace that was created when the original question was posed.

Constraints:

- The user sentiment can only be requested once the agent gives a direct answer.
- The original question's trace_id should be returned, along with the start time of the activity that triggered the original trace call, as data-\* attributes on the frontend

Output Format:

- This should be a thumbs up and thumbs down choice that is made visible directly after the question is answered by the user.
- The sentiment analysis sends the thumbs up/down rating as a trace span in the trace that kicked off the agent
- The answer is either 'good' or 'bad'
- Once the answer is gathered, switch back to the original element that lets the user ask an AI-based question

Failure Conditions:

- The sentiment check appears when the chatbot denies the user's question based on the agent evaluation of the content
- The sentiment check can be requested before the agent gives a direct answer.
