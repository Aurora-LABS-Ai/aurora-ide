# Chat Completion

> Create a chat completion model that generates AI replies for given conversation messages. It supports multimodal inputs (text, images, audio, video, file), offers configurable parameters (like temperature, max tokens, tool use), and supports both streaming and non-streaming output modes.



## OpenAPI

````yaml POST /paas/v4/chat/completions
openapi: 3.0.1
info:
  title: Z.AI API
  description: Z.AI API available endpoints
  license:
    name: Z.AI Developer Agreement and Policy
    url: https://chat.z.ai/legal-agreement/terms-of-service
  version: 1.0.0
  contact:
    name: Z.AI Developers
    url: https://chat.z.ai/legal-agreement/privacy-policy
    email: user_feedback@z.ai
servers:
  - url: https://api.z.ai/api
    description: Production server
security:
  - bearerAuth: []
paths:
  /paas/v4/chat/completions:
    post:
      description: >-
        Create a chat completion model that generates AI replies for given
        conversation messages. It supports multimodal inputs (text, images,
        audio, video, file), offers configurable parameters (like temperature,
        max tokens, tool use), and supports both streaming and non-streaming
        output modes.
      parameters:
        - $ref: '#/components/parameters/AcceptLanguage'
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: '#/components/schemas/ChatCompletionTextRequest'
                  title: Text Model
                - $ref: '#/components/schemas/ChatCompletionVisionRequest'
                  title: Vision Model
            examples:
              Basic Example:
                value:
                  model: glm-4.7
                  messages:
                    - role: system
                      content: You are a useful AI assistant.
                    - role: user
                      content: >-
                        Please tell us about the development of artificial
                        intelligence.
                  temperature: 1
                  stream: false
              Stream Example:
                value:
                  model: glm-4.7
                  messages:
                    - role: user
                      content: Write a poem about spring.
                  temperature: 1
                  stream: true
              Thinking Example:
                value:
                  model: glm-4.7
                  messages:
                    - role: user
                      content: Write a poem about spring.
                  thinking:
                    type: enabled
                  stream: true
              Multi Conversation:
                value:
                  model: glm-4.7
                  messages:
                    - role: system
                      content: You are a professional programming assistant.
                    - role: user
                      content: What is recursion?
                    - role: assistant
                      content: >-
                        Recursion is a programming technique where a function
                        calls itself to solve a problem... What is recursion
                    - role: user
                      content: Can you give me an example of Python recursion?
                  stream: true
              Image Visual Example:
                value:
                  model: glm-4.6v
                  messages:
                    - role: user
                      content:
                        - type: image_url
                          image_url:
                            url: https://cdn.bigmodel.cn/static/logo/register.png
                        - type: image_url
                          image_url:
                            url: https://cdn.bigmodel.cn/static/logo/api-key.png
                        - type: text
                          text: What are the pics talk about?
              Video Visual Example:
                value:
                  model: glm-4.6v
                  messages:
                    - role: user
                      content:
                        - type: video_url
                          video_url:
                            url: >-
                              https://cdn.bigmodel.cn/agent-demos/lark/113123.mov
                        - type: text
                          text: What are the video show about?
              File Visual Example:
                value:
                  model: glm-4.6v
                  messages:
                    - role: user
                      content:
                        - type: file_url
                          file_url:
                            url: https://cdn.bigmodel.cn/static/demo/demo2.txt
                        - type: file_url
                          file_url:
                            url: https://cdn.bigmodel.cn/static/demo/demo1.pdf
                        - type: text
                          text: What are the files show about?
              Function Call Example:
                value:
                  model: glm-4.7
                  messages:
                    - role: user
                      content: >-
                        Is there an example of how the weather in Beijing is
                        today?
                  tools:
                    - type: function
                      function:
                        name: get_weather
                        description: Get weather information for the specified city.
                        parameters:
                          type: object
                          properties:
                            city:
                              type: string
                              description: City Name
                          required:
                            - city
                  tool_choice: auto
                  temperature: 0.3
        required: true
      responses:
        '200':
          description: Processing successful
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ChatCompletionResponse'
        default:
          description: The request has failed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
components:
  parameters:
    AcceptLanguage:
      name: Accept-Language
      in: header
      schema:
        type: string
        description: Config desired response language for HTTP requests.
        default: en-US,en
        example: en-US,en
        enum:
          - en-US,en
      required: false
  schemas:
    ChatCompletionTextRequest:
      required:
        - model
        - messages
      type: object
      properties:
        model:
          type: string
          description: >-
            The model code to be called. GLM-4.7 are the latest flagship model
            series, foundational models specifically designed for agent
            applications.
          example: glm-4.7
          default: glm-4.7
          enum:
            - glm-4.7
            - glm-4.6
            - glm-4.5
            - glm-4.5-air
            - glm-4.5-x
            - glm-4.5-airx
            - glm-4.5-flash
            - glm-4-32b-0414-128k
        messages:
          type: array
          description: >-
            The current conversation message list as the model’s prompt input,
            provided in JSON array format, e.g.,`{“role”: “user”, “content”:
            “Hello”}`. Possible message types include system messages, user
            messages, assistant messages, and tool messages. Note: The input
            must not consist of system messages or assistant messages only.
          items:
            oneOf:
              - title: User Message
                type: object
                properties:
                  role:
                    type: string
                    enum:
                      - user
                    description: Role of the message author
                    default: user
                  content:
                    oneOf:
                      - type: string
                        description: Text message content
                        example: >-
                          What opportunities and challenges will the Chinese
                          large model industry face in 2025?
                required:
                  - role
                  - content
              - title: System Message
                type: object
                properties:
                  role:
                    type: string
                    enum:
                      - system
                    description: Role of the message author
                    default: system
                  content:
                    oneOf:
                      - type: string
                        description: Message text content
                        example: You are a helpful assistant.
                required:
                  - role
                  - content
              - title: Assistant Message
                type: object
                description: Can include tool calls
                properties:
                  role:
                    type: string
                    enum:
                      - assistant
                    description: Role of the message author
                    default: assistant
                  content:
                    oneOf:
                      - type: string
                        description: Text message content
                        example: I'll help you with that analysis.
                  tool_calls:
                    type: array
                    description: >-
                      Tool call messages generated by the model. When this field
                      is provided, content is usually empty.
                    items:
                      type: object
                      properties:
                        id:
                          type: string
                          description: Tool call ID
                        type:
                          type: string
                          description: Tool type, supports web_search, retrieval, function
                          enum:
                            - function
                            - web_search
                            - retrieval
                        function:
                          type: object
                          description: >-
                            Function call information, not empty when type is
                            function
                          properties:
                            name:
                              type: string
                              description: Function name
                            arguments:
                              type: string
                              description: Function parameters, JSON format string
                          required:
                            - name
                            - arguments
                      required:
                        - id
                        - type
                required:
                  - role
              - title: Tool Message
                type: object
                properties:
                  role:
                    type: string
                    enum:
                      - tool
                    description: Role of the message author
                    default: tool
                  content:
                    oneOf:
                      - type: string
                        description: Message text content
                        example: 'Function executed successfully with result: ...'
                  tool_call_id:
                    type: string
                    description: Indicates the tool call ID corresponding to this message
                required:
                  - role
                  - content
                  - tool_call_id
          minItems: 1
        request_id:
          type: string
          description: >-
            Passed by the user side, needs to be unique; used to distinguish
            each request. If not provided by the user side, the platform will
            generate one by default.
        do_sample:
          type: boolean
          example: true
          default: true
          description: >-
            When do_sample is true, sampling strategy is enabled; when do_sample
            is false, sampling strategy parameters such as temperature and top_p
            will not take effect. Default value is `true`.
        stream:
          type: boolean
          example: false
          default: false
          description: >-
            This parameter should be set to false or omitted when using
            synchronous call. It indicates that the model returns all content at
            once after generating all content. Default value is false. If set to
            true, the model will return the generated content in chunks via
            standard Event Stream. When the Event Stream ends, a `data: [DONE]`
            message will be returned.
        thinking:
          $ref: '#/components/schemas/ChatThinking'
        temperature:
          type: number
          description: >-
            Sampling temperature, controls the randomness of the output, must be
            a positive number within the range: `[0.0, 1.0]`. The GLM-4.7
            GLM-4.6 series default value is `1.0`, GLM-4.5 series default value
            is `0.6`, GLM-4-32B-0414-128K default value is `0.75`.
          format: float
          example: 1
          default: 1
          minimum: 0
          maximum: 1
        top_p:
          type: number
          description: >-
            Another method of temperature sampling, value range is: `[0.01,
            1.0]`. The GLM-4.7, GLM-4.6, GLM-4.5 series default value is `0.95`,
            GLM-4-32B-0414-128K default value is `0.9`.
          format: float
          example: 0.95
          default: 0.95
          minimum: 0.01
          maximum: 1
        max_tokens:
          type: integer
          description: >-
            The maximum number of tokens for model output, the GLM-4.7 GLM-4.6
            series supports 128K maximum output, the GLM-4.5 series supports 96K
            maximum output, the GLM-4.6v series supports 32K maximum output, the
            GLM-4.5v series supports 16K maximum output, GLM-4-32B-0414-128K
            supports 16K maximum output.
          example: 1024
          minimum: 1
          maximum: 131072
        tool_stream:
          type: boolean
          example: false
          default: false
          description: >-
            Whether to enable streaming response for Function Calls. Default
            value is false. Only supported by GLM-4.6. Refer the [Stream Tool
            Call](/guides/tools/stream-tool)
        tools:
          type: array
          description: >
            A list of tools the model may call. Currently, only functions are
            supported as a tool. Use this to provide a list of functions the
            model may generate JSON inputs for. A max of 128 functions are
            supported.
          items:
            anyOf:
              - $ref: '#/components/schemas/FunctionToolSchema'
              - $ref: '#/components/schemas/RetrievalToolSchema'
              - $ref: '#/components/schemas/WebSearchToolSchema'
        tool_choice:
          oneOf:
            - type: string
              enum:
                - auto
              description: >-
                Used to control how the model selects which function to call.
                This is only applicable when the tool type is function. The
                default value is auto, and only auto is supported.
          description: Controls how the model selects a tool.
        stop:
          type: array
          description: >-
            Stop word list. Generation stops when the model encounters any
            specified string. Currently, only one stop word is supported, in the
            format ["stop_word1"].
          items:
            type: string
          maxItems: 1
        response_format:
          type: object
          description: >-
            Specifies the response format of the model. Defaults to text.
            Supports two formats:{ "type": "text" } plain text mode, returns
            natural language text, { "type": "json_object" } JSON mode, returns
            valid JSON data. When using JSON mode, it’s recommended to clearly
            request JSON output in the prompt.
          properties:
            type:
              type: string
              enum:
                - text
                - json_object
              default: text
              description: >-
                Output format type: text for plain text, json_object for
                JSON-formatted output.
          required:
            - type
        user_id:
          type: string
          description: >-
            Unique ID for the end user, 6–128 characters. Avoid using sensitive
            information.
          minLength: 6
          maxLength: 128
    ChatCompletionVisionRequest:
      required:
        - model
        - messages
      type: object
      properties:
        model:
          type: string
          description: >-
            The model code to be called. GLM-4.6V are the new generation of
            visual reasoning models. `AutoGLM-Phone-Multilingual` is mobile
            intelligent assistant model.
          example: glm-4.6v
          default: glm-4.6v
          enum:
            - glm-4.6v
            - autoglm-phone-multilingual
            - glm-4.6v-flash
            - glm-4.6v-flashx
            - glm-4.5v
        messages:
          type: array
          description: >-
            The current conversation message list as the model’s prompt input,
            provided in JSON array format, e.g.,`{“role”: “user”, “content”:
            “Hello”}`. Possible message types include system messages, user
            messages. Note: The input must not consist of system or assistant
            messages only.
          items:
            oneOf:
              - title: User Message
                type: object
                properties:
                  role:
                    type: string
                    enum:
                      - user
                    description: Role of the message author
                    default: user
                  content:
                    oneOf:
                      - type: array
                        description: >-
                          Multimodal message content, supports text, images,
                          video, file
                        items:
                          $ref: '#/components/schemas/VisionMultimodalContentItem'
                      - type: string
                        description: >-
                          Text message content (can switch to multimodal message
                          above)
                        example: >-
                          What opportunities and challenges will the Chinese
                          large model industry face in 2025?
                required:
                  - role
                  - content
              - title: System Message
                type: object
                properties:
                  role:
                    type: string
                    enum:
                      - system
                    description: Role of the message author
                    default: system
                  content:
                    oneOf:
                      - type: string
                        description: Message text content
                        example: You are a helpful assistant.
                required:
                  - role
                  - content
              - title: Assistant Message
                type: object
                description: Can include tool calls
                properties:
                  role:
                    type: string
                    enum:
                      - assistant
                    description: Role of the message author
                    default: assistant
                  content:
                    oneOf:
                      - type: string
                        description: Text message content
                        example: I'll help you with that analysis.
                required:
                  - role
          minItems: 1
        request_id:
          type: string
          description: >-
            Passed by the user side, needs to be unique; used to distinguish
            each request. If not provided by the user side, the platform will
            generate one by default.
        do_sample:
          type: boolean
          example: true
          default: true
          description: >-
            When do_sample is true, sampling strategy is enabled; when do_sample
            is false, sampling strategy parameters such as temperature and top_p
            will not take effect. Default value is `true`.
        stream:
          type: boolean
          example: false
          default: false
          description: >-
            This parameter should be set to false or omitted when using
            synchronous call. It indicates that the model returns all content at
            once after generating all content. Default value is false. If set to
            true, the model will return the generated content in chunks via
            standard Event Stream. When the Event Stream ends, a `data: [DONE]`
            message will be returned.
        thinking:
          $ref: '#/components/schemas/ChatThinking'
        temperature:
          type: number
          description: >-
            Sampling temperature, controls the randomness of the output, must be
            a positive number within the range: `[0.0, 1.0]`. The GLM-4.6V,
            GLM-4.5V series default value is `0.8`, the
            autoglm-phone-multilingual default value is `0.0`.
          format: float
          example: 0.8
          default: 0.8
          minimum: 0
          maximum: 1
        top_p:
          type: number
          description: >-
            Another method of temperature sampling, value range is: `[0.01,
            1.0]`, value range is: `[0.01, 1.0]`. The GLM-4.6V, GLM-4.5V series
            default value is `0.6`, the autoglm-phone-multilingual default value
            is `0.85`.
          format: float
          example: 0.6
          default: 0.6
          minimum: 0.01
          maximum: 1
        max_tokens:
          type: integer
          description: >-
            The maximum number of tokens for model output, the GLM-4.6V series
            supports 32K maximum output, the GLM-4.5V series supports 16K
            maximum output, the autoglm-phone-multilingual supports 4K maximum
            output.
          example: 1024
          minimum: 1
          maximum: 16384
        tools:
          type: array
          description: >
            A list of tools the model may call. Only support by GLM-4.6V series
            and autoglm-phone-multilingual. Use this to provide a list of
            functions the model may generate JSON inputs for. A max of 128
            functions are supported.
          items:
            anyOf:
              - $ref: '#/components/schemas/FunctionToolSchema'
        tool_choice:
          oneOf:
            - type: string
              enum:
                - auto
              description: >-
                Used to control how the model selects which function to call.
                This is only applicable when the tool type is function. The
                default value is auto, and only auto is supported.
          description: Controls how the model selects a tool.
        stop:
          type: array
          description: >-
            Stop word list. Generation stops when the model encounters any
            specified string. Currently, only one stop word is supported, in the
            format ["stop_word1"].
          items:
            type: string
          maxItems: 1
        user_id:
          type: string
          description: >-
            Unique ID for the end user, 6–128 characters. Avoid using sensitive
            information.
          minLength: 6
          maxLength: 128
    ChatCompletionResponse:
      type: object
      properties:
        id:
          type: string
          description: Task ID
        request_id:
          description: Request ID
          type: string
        created:
          description: Request creation time, Unix timestamp in seconds
          type: integer
        model:
          description: Model name
          type: string
        choices:
          type: array
          description: List of model responses
          items:
            type: object
            properties:
              index:
                type: integer
                description: Result index.
              message:
                $ref: '#/components/schemas/ChatCompletionResponseMessage'
              finish_reason:
                type: string
                description: >-
                  Reason for model inference termination. Can be ‘stop’,
                  ‘tool_calls’, ‘length’, ‘sensitive’, or ‘network_error’.
        usage:
          type: object
          description: Token usage statistics returned when the model call ends.
          properties:
            prompt_tokens:
              type: number
              description: Number of tokens in user input
            completion_tokens:
              type: number
              description: Number of output tokens
            prompt_tokens_details:
              type: object
              properties:
                cached_tokens:
                  type: number
                  description: Number of tokens served from cache
            total_tokens:
              type: integer
              description: Total number of tokens
        web_search:
          description: Search results.
          type: array
          items:
            $ref: '#/components/schemas/WebSearchObjectResponse'
    Error:
      required:
        - code
        - message
      type: object
      description: The request has failed.
      properties:
        code:
          type: integer
          format: int32
          description: Error code.
        message:
          type: string
          description: Error message.
    ChatThinking:
      type: object
      description: >-
        Only supported by GLM-4.5 series and higher models. This parameter is
        used to control whether the model enable the chain of thought.
      properties:
        type:
          type: string
          description: >-
            Whether to enable the chain of thought(When enabled, GLM-4.7
            GLM-4.5V will think compulsorily, while GLM-4.6, GLM-4.6V, GLM-4.5
            and others will automatically determine whether to think), default:
            enabled
          default: enabled
          enum:
            - enabled
            - disabled
        clear_thinking:
          type: boolean
          description: >-
            Default value is True. Controls whether to clear `reasoning_content`
            from previous conversation turns. View more in [Thinking
            Mode](/guides/capabilities/thinking-mode). 
             - `true` (default): For this request, the system ignores/removes `reasoning_content` from prior turns, and only keeps non-reasoning context (e.g., user/assistant visible text, tool calls, and tool results). This is recommended for general chat or lightweight tasks to reduce context length and cost. 
             - `false`: Retains `reasoning_content` from prior turns and includes it in the context sent to the model. To enable Preserved Thinking, you must forward the full, unmodified, and correctly ordered historical `reasoning_content` in `messages`. Missing, truncated, rewritten, or reordered blocks may degrade performance or prevent the feature from taking effect. 
             - Notes: This parameter only affects cross-turn historical thinking blocks; it does not change whether the model generates/returns thinking in the current turn.
          default: true
          example: true
    FunctionToolSchema:
      type: object
      title: Function Call
      properties:
        type:
          type: string
          default: function
          enum:
            - function
        function:
          $ref: '#/components/schemas/FunctionObject'
      required:
        - type
        - function
      additionalProperties: false
    RetrievalToolSchema:
      type: object
      title: Retrieval
      properties:
        type:
          type: string
          default: retrieval
          enum:
            - retrieval
        retrieval:
          $ref: '#/components/schemas/RetrievalObject'
      required:
        - type
        - retrieval
      additionalProperties: false
    WebSearchToolSchema:
      type: object
      title: Web Search
      properties:
        type:
          type: string
          default: web_search
          enum:
            - web_search
        web_search:
          $ref: '#/components/schemas/WebSearchObject'
      required:
        - type
        - web_search
      additionalProperties: false
    VisionMultimodalContentItem:
      oneOf:
        - title: Text
          type: object
          properties:
            type:
              type: string
              enum:
                - text
              description: Content type is text
              default: text
            text:
              type: string
              description: Text content
          required:
            - type
            - text
          additionalProperties: false
        - title: Image
          type: object
          properties:
            type:
              type: string
              enum:
                - image_url
              description: Content type is image URL
              default: image_url
            image_url:
              type: object
              description: Image information
              properties:
                url:
                  type: string
                  description: >-
                    Image URL or Base64 encoding. Image size limit is under 5M
                    per image, with pixels not exceeding 6000*6000. Supports
                    jpg, png, jpeg formats.
              required:
                - url
              additionalProperties: false
          required:
            - type
            - image_url
          additionalProperties: false
        - title: Video
          type: object
          properties:
            type:
              type: string
              enum:
                - video_url
              description: Content type is video URL
              default: video_url
            video_url:
              type: object
              description: Video information.
              properties:
                url:
                  type: string
                  description: >-
                    Video URL address.The video size is limited to within 200
                    MB, and the format supports `mp4`，`mkv`，`mov`.
              required:
                - url
              additionalProperties: false
          required:
            - type
            - video_url
          additionalProperties: false
        - title: File
          type: object
          properties:
            type:
              type: string
              enum:
                - file_url
              description: >-
                Content type is file URL, not support passing both the
                `file_url` and `image_url` or `video_url` parameters at the same
                time.
              default: file_url
            file_url:
              type: object
              description: File information.
              properties:
                url:
                  type: string
                  description: >-
                    File URL address. Only GLM-4.6V, GLM-4.5V supported.
                    Supports formats such as pdf、txt、word、jsonl、xlsx、pptx, with
                    a maximum of 50.
              required:
                - url
              additionalProperties: false
          required:
            - type
            - file_url
          additionalProperties: false
    ChatCompletionResponseMessage:
      type: object
      properties:
        role:
          type: string
          description: Current conversation role, default is ‘assistant’ (model)
          example: assistant
        content:
          type: string
          description: >-
            Current conversation content. Hits function is null, otherwise
            returns model inference result. 

            For the GLM-4.5V series models, the output may contain the reasoning
            process tags `<think> </think>` or the text boundary tags
            `<|begin_of_box|> <|end_of_box|>`.
        reasoning_content:
          type: string
          description: Reasoning content, supports by GLM-4.5 series.
        tool_calls:
          type: array
          description: >-
            Function names and parameters generated by the model that should be
            called.
          items:
            $ref: '#/components/schemas/ChatCompletionResponseMessageToolCall'
    WebSearchObjectResponse:
      type: object
      properties:
        title:
          type: string
          description: Title.
        content:
          type: string
          description: Content summary.
        link:
          type: string
          description: Result URL.
        media:
          type: string
          description: Website name.
        icon:
          type: string
          description: Website icon.
        refer:
          type: string
          description: Index number.
        publish_date:
          type: string
          description: Website publication date.
    FunctionObject:
      type: object
      properties:
        name:
          type: string
          description: >-
            The name of the function to be called. Must be a-z, A-Z, 0-9, or
            contain underscores and dashes, with a maximum length of 64.
          minLength: 1
          maxLength: 64
          pattern: ^[a-zA-Z0-9_-]+$
        description:
          type: string
          description: >-
            A description of what the function does, used by the model to choose
            when and how to call the function.
        parameters:
          $ref: '#/components/schemas/FunctionParameters'
      required:
        - name
        - description
        - parameters
    RetrievalObject:
      type: object
      properties:
        knowledge_id:
          type: string
          description: Knowledge base ID, created or obtained from the platform
        prompt_template:
          type: string
          description: >-
            Prompt template for requesting the model, a custom request template
            containing placeholders `{{ knowledge }}` and `{{ question }}`.
            Default template: Search for the answer to the question
            `{{question}}` in the document `{{ knowledge }}`. If an answer is
            found, respond only using statements from the document; if no answer
            is found, use your own knowledge to answer and inform the user that
            the information is not from the document. Do not repeat the
            question, start the answer directly.
      required:
        - knowledge_id
    WebSearchObject:
      type: object
      properties:
        enable:
          type: boolean
          description: |-
            Whether to enable search functionality.
            Default is `false`. Set to true to `enable`.
        search_engine:
          type: string
          description: |-
            Type of search engine.
            Default is `search_pro_jina`. Supports: `search_pro_jina`.
          enum:
            - search_pro_jina
        search_query:
          type: string
          description: Force trigger a search
        count:
          type: integer
          description: |
            Number of returned results
            Range: `1-50`, max `50` results per search
            Default is `10`
            Supported engines: `search_pro_jina`
          minimum: 1
          maximum: 50
        search_domain_filter:
          type: string
          description: >-
            Limits search results to specified whitelisted domains. Whitelist:
            input domains directly (e.g., www.example.com)

            Supported engines: `search_pro_jina`
        search_recency_filter:
          type: string
          description: |-
            Limits search to a specific time range.
            Default is `noLimit`
            Values:
            `oneDay`, within a day
            `oneWeek`, within a week
            `oneMonth`, within a month
            `oneYear`, within a year
            `noLimit`, no limit (default)
            Supported engines: `search_pro_jina`
          enum:
            - oneDay
            - oneWeek
            - oneMonth
            - oneYear
            - noLimit
        content_size:
          type: string
          description: >-
            Number of characters for webpage summaries.

            Default is `medium`

            `medium`: Balanced mode for most queries. 400-600 characters

            `high`: Maximizes context for comprehensive answers, 2500
            characters.
          enum:
            - medium
            - high
        result_sequence:
          type: string
          description: >-
            Specifies whether search results are shown before or after model
            response. Options: `before`, `after`. Default is `after`
          enum:
            - before
            - after
        search_result:
          type: boolean
          description: |-
            Whether to return search results in the response.
            Default is `false`
        require_search:
          type: boolean
          description: |-
            Whether to force model response based on search result.
            Default is `false`
        search_prompt:
          type: string
          description: >-
            Prompt to customize how search results are processed.

            Default Prompt:

            `You are an intelligent Q&A expert with the ability to synthesize
            information, recognize time, understand semantics, and clean
            contradictory data. The current date is {{current_date}}. Use this
            as the only time reference. Based on the following information,
            provide a comprehensive and accurate answer to the user's
            question.Only extract valuable content for the answer. Ensure the
            answer is timely and authoritative. State the answer directly
            without citing data sources or internal processes.`
      required:
        - search_engine
    ChatCompletionResponseMessageToolCall:
      type: object
      properties:
        function:
          type: object
          description: >-
            Contains the function name and JSON format parameters generated by
            the model.
          properties:
            name:
              type: string
              description: Model-generated function name.
            arguments:
              type: object
              description: >-
                JSON format of the function call parameters generated by the
                model. Validate the parameters before calling the function.
          required:
            - name
            - arguments
        id:
          type: string
          description: Unique identifier for the hit function.
        type:
          type: string
          description: Tool type called by the model, currently only supports ‘function’.
    FunctionParameters:
      type: object
      description: >-
        Parameters defined using JSON Schema. Must pass a JSON Schema object to
        accurately define accepted parameters. Omit if no parameters are needed
        when calling the function.
      additionalProperties: true
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: >-
        Use the following format for authentication: Bearer [<your api
        key>](https://z.ai/manage-apikey/apikey-list)

````

---

> To find navigation and other pages in this documentation, fetch the llms.txt file at: https://docs.z.ai/llms.txt# Quick Start

<Tip>
  This guide will help you get started with [GLM Coding Plan](https://z.ai/subscribe?utm_source=zai\&utm_medium=link\&utm_term=quickstart\&utm_campaign=Platform_Ops&_channel_track_key=DRUfXN42) in minutes—from subscribing to using the GLM-4.7 model in coding tools.

  **Christmas Deal:** Enjoy 50% off your first GLM Coding Plan purchase, **plus an extra 10%/20% off**! [Subscribe](https://z.ai/subscribe?utm_source=z.ai\&utm_medium=link\&utm_term=glm-devpack\&utm_campaign=Platform_Ops&_channel_track_key=jFgqJREK) now.
</Tip>

## Getting Started

<Steps>
  <Step title="Register or Login">
    * Access [Z.AI Open Platform](https://z.ai/model-api), Register or Login.
      <img src="https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-1.png?fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=a888ed8ef0db74f61a2c3ade2c9d5901" alt="description" data-og-width="1201" width="1201" data-og-height="1011" height="1011" data-path="resource/quickstart-1.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-1.png?w=280&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=c7d122c8d8c5cb523563723a30689576 280w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-1.png?w=560&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=ad32625cd94dd558c563b2d8d6cdf507 560w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-1.png?w=840&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=b35e5e9af5d964d0b76e68564ecebc3f 840w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-1.png?w=1100&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=b35b068aa0f533eff62f088660313794 1100w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-1.png?w=1650&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=5969baade59e5ccd11e4d1b172646ee4 1650w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-1.png?w=2500&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=f038c395610eeeac2850a9cf5ca222a4 2500w" />
  </Step>

  <Step title="Subscribe to GLM Coding Plan">
    After logging in, navigate to the [GLM Coding Plan](https://z.ai/subscribe?utm_source=zai\&utm_medium=link\&utm_term=quickstart\&utm_campaign=Platform_Ops&_channel_track_key=DRUfXN42) to select your preferred subscription plan.
    <img src="https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-2.png?fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=d80f9382635a3910c6f6949a485a0fc2" alt="description" data-og-width="2582" width="2582" data-og-height="1610" height="1610" data-path="resource/quickstart-2.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-2.png?w=280&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=912539c83b4633493bbdb0e40b034107 280w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-2.png?w=560&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=e6bc7f999c0f03277c68e60a088e39d1 560w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-2.png?w=840&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=c8cab0aa1bfd56ec7cae17341173126f 840w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-2.png?w=1100&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=8e4fa5227a0cfb8bc768ab1487d6a540 1100w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-2.png?w=1650&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=d0ddb1d5751f2c54b396a6241669b91e 1650w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-2.png?w=2500&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=44b9beb043ea879f85e44008d6adc9c5 2500w" />
  </Step>

  <Step title="Obtain API Key">
    After subscribing, navigate to your account dashboard and click [API Keys](https://z.ai/manage-apikey/apikey-list) to generate a new API Key.
    <img src="https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-3.png?fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=65e4a2f900d7ace56ea241a2d0e12ab7" alt="description" data-og-width="2926" width="2926" data-og-height="958" height="958" data-path="resource/quickstart-3.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-3.png?w=280&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=005a5e2c25874df1950f5d6936803392 280w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-3.png?w=560&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=3ebdcae387e230eb8cf0f965fb008a7b 560w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-3.png?w=840&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=d4f883930a875c3152bb2b823e424a09 840w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-3.png?w=1100&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=cf61c47cc0953988fffd26dc06907642 1100w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-3.png?w=1650&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=04974b7c9bb354514d84da0d3060ba50 1650w, https://mintcdn.com/zhipu-32152247/tXQnmemMntMF1TeM/resource/quickstart-3.png?w=2500&fit=max&auto=format&n=tXQnmemMntMF1TeM&q=85&s=691aa0831c1e0b834fac5ba8f9bd8924 2500w" />

    <Warning>
      Safeguard your API Key by keeping it confidential and avoiding hard-coding it in your code. We recommend storing it in environment variables or configuration files.
    </Warning>
  </Step>

  <Step title="Select Coding Tool">
    GLM Coding Plan supports multiple mainstream coding tools. Choose based on your preference:

    <CardGroup cols={3}>
      <Card title="Claude Code" color="#ffffff" href="https://docs.z.ai/devpack/tool/claude" />

      <Card title="Roo Code" color="#ffffff" href="https://docs.z.ai/devpack/tool/roo" />

      <Card title="Kilo Code" color="#ffffff" href="https://docs.z.ai/devpack/tool/kilo" />

      <Card title="Cline" color="#ffffff" href="https://docs.z.ai/devpack/tool/cline" />

      <Card title="OpenCode" color="#ffffff" href="https://docs.z.ai/devpack/tool/opencode" />

      <Card title="Crush" color="#ffffff" href="https://docs.z.ai/devpack/tool/crush" />

      <Card title="Goose" color="#ffffff" href="https://docs.z.ai/devpack/tool/goose" />

      <Card title="Cursor" color="#ffffff" href="https://docs.z.ai/devpack/tool/cursor" />

      <Card title="Other Tools" color="#ffffff" href="https://docs.z.ai/devpack/tool/others" />
    </CardGroup>
  </Step>

  <Step title="Configuring Coding Tools">
    Using Claude Code as an example, configure the GLM-4.7 model:

    <Tabs>
      <Tab title="Claude Code">
        **1. Install Claude Code**

        Prerequisite: You need to install [Node.js 18 or latest version](https://nodejs.org/en/download/)

        ```bash  theme={null}
        # Open your terminal and install Claude Code
        npm install -g @anthropic-ai/claude-code

        # Create your working directory (e.g., `your-project`) and navigate to it using `cd`
        cd your-project

        # After installation, run `claude` to enter the Claude Code interactive interface
        claude
        ```

        **2. Configure Environment Variables**

        After installing Claude Code, set up environment variables using one of the following methods by enter the following commands in the **Mac OS terminal** or **Windows cmd**:

        <Tip>
          **Note**: When setting environment variables, the terminal will not return any output. This is normal, as long as no error message appears, the configuration has been applied successfully.
        </Tip>

        **Method 1: Automated Coding Tool Helper**

        Coding Tool Helper is a coding-tool companion that quickly loads **GLM Coding Plan** into your favorite **Coding Tools**. Install and run it, then follow the on-screen guidance to automatically install tools, configure plan, and manage MCP servers.

        ```bash  theme={null}
        # Run Coding Tool Helper directly in the terminal
        npx @z_ai/coding-helper
        ```

        For more details, please refer to the [Coding Tool Helper](/devpack/tool/coding-tool-helper) documentation.

        **Method 2: Using a Script (Recommended for First-Time Users)**

        Just run the following command in your terminal. Attention only macOS Linux environment is supported, this method does not support Windows

        ```bash  theme={null}
        curl -O "https://cdn.bigmodel.cn/install/claude_code_zai_env.sh" && bash ./claude_code_zai_env.sh
        ```

        **Method 3: Manual Configuration**

        If you have previously configured environment variables for Claude Code, you can manually configure them as follows. A new window is required for the changes to take effect.

        <CodeGroup>
          ```bash MacOS & Linux theme={null}
          # Edit the Claude Code configuration file `~/.claude/settings.json`
          # Add or modify the env fields ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN
          # Note to replace `your_zai_api_key` with the API Key you obtained in the previous step

          {
              "env": {
                  "ANTHROPIC_AUTH_TOKEN": "your_zai_api_key",
                  "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
                  "API_TIMEOUT_MS": "3000000"
              }
          }
          ```

          ```cmd Windows Cmd theme={null}
          # Run the following commands in Cmd
          # Note to replace `your_zai_api_key` with the API Key you obtained in the previous step

          setx ANTHROPIC_AUTH_TOKEN your_zai_api_key
          setx ANTHROPIC_BASE_URL https://api.z.ai/api/anthropic
          ```

          ```powershell Windows PowerShell theme={null}
          # Run the following commands in PowerShell
          # Note to replace `your_zai_api_key` with the API Key you obtained in the previous step

          [System.Environment]::SetEnvironmentVariable('ANTHROPIC_AUTH_TOKEN', 'your_zai_api_key', 'User')
          [System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic', 'User')
          ```
        </CodeGroup>
      </Tab>

      <Tab title="Other Tools">
        **General Configuration Method**

        For other supported coding tools, configure as follows:

        * **API Provider**: Select OpenAI Compatible
        * **Base URL**: Enter `https://api.z.ai/api/paas/v4`
        * **API Key**: Enter your Z.AI API Key
        * **Model**: Select `GLM-4.7`

        Refer to each tool's detailed documentation for specific configuration steps.
      </Tab>
    </Tabs>
  </Step>

  <Step title="Start Coding">
    Once configured, you can begin coding with GLM-4.7!

    <Tabs>
      <Tab title="Natural Language Programming">
        ```bash  theme={null}
        # Using Natural Language Commands in Claude Code
        Please create a React component containing a user login form
        ```

        GLM-4.7 will automatically:

        * Analyze requirements and formulate an implementation plan
        * Generate complete React component code
        * Include form validation and styling
        * Ensure code runs directly
      </Tab>

      <Tab title="Code Debugging">
        ```bash  theme={null}
        # Describe the Issue Encountered
        My API request returns a 404 error. Please help me check the code.
        ```

        GLM-4.7 will automatically:

        * Analyze your codebase
        * Pinpoint potential causes of issues
        * Provide specific fixes
        * Explain the root causes
      </Tab>

      <Tab title="Code Optimization">
        ```bash  theme={null}
        # Code Optimization
        This function performs poorly. Please optimize it for me.
        ```

        GLM-4.7 will automatically:

        * Analyze performance bottlenecks in your code
        * Provide optimization suggestions and refactoring plans
        * Preserve existing functionality
        * Improve execution efficiency
      </Tab>
    </Tabs>
  </Step>
</Steps>

## Feature Examples

<Card title="Smart Code Completion" icon="code">
  Generates real-time completion suggestions based on context, reducing manual input and significantly boosting development efficiency.

  ```javascript  theme={null}
  // Type function name, GLM-4.7 auto-completes implementation
  function calculateTotal(items) {
      // GLM-4.7 automatically generates complete function implementation
  }
  ```
</Card>

<Card title="Code Repository Q&A" icon="circle-question">
  Ask questions about your team's codebase anytime to maintain a holistic understanding.

  ```
  Q: How is user authentication implemented in this project?
  A: GLM-4.7 analyzes your codebase and provides detailed explanations of the authentication process and related files.
  ```
</Card>

<Card title="Automated Task Management" icon="diagram-subtask">
  One-click fixes for lint issues, merge conflicts, and release note generation.

  ```
  # Auto-fix code style issues
  Fix all ESLint errors

  # Auto-generate documentation
  Generate detailed documentation for this API
  ```
</Card>

## Advanced Features

<AccordionGroup>
  <Accordion title="Vision MCP Server (Coding Plan Exclusive)">
    All users can utilize the Vision MCP Server, which employs the flagship vision reasoning model GLM-4.6V to comprehend and analyze image content.

    * Analyze UI design mockups and generate corresponding code
    * Understand flowcharts and architecture diagrams
    * Extract text and information from screenshots

    For detailed usage instructions, refer to the [Vision MCP Server](/devpack/mcp/vision-mcp-server) documentation.
  </Accordion>

  <Accordion title="Web Search MCP Server (Coding Plan Exclusive)">
    All users can utilize the Web Search MCP Server to access the latest technical information.

    * Search for the latest technical documentation and API changes
    * Obtain the latest information on open-source projects
    * Find solutions and best practices

    For detailed usage instructions, refer to the [Web Search MCP Server](/devpack/mcp/search-mcp-server) documentation.
  </Accordion>

  <Accordion title="Web Reader MCP Server (Coding Plan Exclusive)">
    All users can utilize the Web Reader MCP Server to fetch full webpage content and extract structured data.

    * Fetch complete webpage content including text, and links
    * Extract structured data such as title, body, and metadata
    * Remote HTTP-based MCP service, no local installation required

    For detailed usage instructions, refer to the [Web Reader MCP Server](/devpack/mcp/reader-mcp-server) documentation.
  </Accordion>
</AccordionGroup>


---

> # Stream Tool Call

<Info>
  Stream Tool Call is a unique feature of Z.ai's latest GLM-4.6 model, allowing real-time access to reasoning processes, response content, and tool call information during tool invocation, providing better user experience and real-time feedback.
</Info>

## Features

Tool calling in the latest GLM-4.6 model now supports streaming output for responses. This allows developers to stream tool usage parameters without buffering or JSON validation when calling `chat.completions`, thereby reducing call latency and providing a better user experience.

### Core Parameter Description

* **`stream=True`**: Enable streaming output, must be set to `True`
* **`tool_stream=True`**: Enable tool call streaming output
* **`model`**: Use a model that supports tool calling, limited to `glm-4.6`

### Response Parameter Description

The `delta` object in streaming responses contains the following fields:

* **`reasoning_content`**: Text content of the model's reasoning process
* **`content`**: Text content of the model's response
* **`tool_calls`**: Tool call information, including function names and parameters

## Code Example

By setting the `tool_stream=True` parameter, you can enable streaming tool call functionality:

<Tabs>
  <Tab title="Python SDK">
    **Install SDK**

    ```bash  theme={null}
    # Install latest version
    pip install zai-sdk

    # Or specify version
    pip install zai-sdk==0.1.0
    ```

    **Verify Installation**

    ```python  theme={null}
    import zai
    print(zai.__version__)
    ```

    **Complete Example**

    ```python  theme={null}
    from zai import ZaiClient

    # Initialize client
    client = ZaiClient(api_key='Your API key')

    # Create streaming tool call request
    response = client.chat.completions.create(
        model="glm-4.6",  # Use model that supports tool calling
        messages=[
            {"role": "user", "content": "How's the weather in Beijing?"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get current weather conditions for a specified location",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string", "description": "City, e.g.: Beijing, Shanghai"},
                            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                        },
                        "required": ["location"]
                    }
                }
            }
        ],
        stream=True,        # Enable streaming output
        tool_stream=True    # Enable tool call streaming output
    )

    # Initialize variables to collect streaming data
    reasoning_content = ""      # Reasoning process content
    content = ""               # Response content
    final_tool_calls = {}      # Tool call information
    reasoning_started = False  # Reasoning process start flag
    content_started = False    # Content output start flag

    # Process streaming response
    for chunk in response:
        if not chunk.choices:
            continue

        delta = chunk.choices[0].delta

        # Handle streaming reasoning process output
        if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
            if not reasoning_started and delta.reasoning_content.strip():
                print("\n🧠 Thinking Process:")
                reasoning_started = True
            reasoning_content += delta.reasoning_content
            print(delta.reasoning_content, end="", flush=True)

        # Handle streaming response content output
        if hasattr(delta, 'content') and delta.content:
            if not content_started and delta.content.strip():
                print("\n\n💬 Response Content:")
                content_started = True
            content += delta.content
            print(delta.content, end="", flush=True)

        # Handle streaming tool call information
        if delta.tool_calls:
            for tool_call in delta.tool_calls:
                index = tool_call.index
                if index not in final_tool_calls:
                    # New tool call
                    final_tool_calls[index] = tool_call
                    final_tool_calls[index].function.arguments = tool_call.function.arguments
                else:
                    # Append tool call parameters (streaming construction)
                    final_tool_calls[index].function.arguments += tool_call.function.arguments

    # Output final tool call information
    if final_tool_calls:
        print("\n📋 Function Calls Triggered:")
        for index, tool_call in final_tool_calls.items():
            print(f"  {index}: Function Name: {tool_call.function.name}, Parameters: {tool_call.function.arguments}")
    ```
  </Tab>
</Tabs>

## Use Cases

<CardGroup cols={2}>
  <Card title="Intelligent Customer Service System" icon="headset">
    * Real-time display of query progress
    * Improve waiting experience
  </Card>

  <Card title="Code Assistant" icon="code">
    * Real-time code analysis process
    * Display tool call chain
  </Card>
</CardGroup>


---

> To find navigation and other pages in this documentation, fetch the llms.txt file at: https://docs.z.ai/llms.txtTo find navigation and other pages in this documentation, fetch the llms.txt file at: https://docs.z.ai/llms.txt
# Stream Tool Call

<Info>
  Stream Tool Call is a unique feature of Z.ai's latest GLM-4.6 model, allowing real-time access to reasoning processes, response content, and tool call information during tool invocation, providing better user experience and real-time feedback.
</Info>

## Features

Tool calling in the latest GLM-4.6 model now supports streaming output for responses. This allows developers to stream tool usage parameters without buffering or JSON validation when calling `chat.completions`, thereby reducing call latency and providing a better user experience.

### Core Parameter Description

* **`stream=True`**: Enable streaming output, must be set to `True`
* **`tool_stream=True`**: Enable tool call streaming output
* **`model`**: Use a model that supports tool calling, limited to `glm-4.6`

### Response Parameter Description

The `delta` object in streaming responses contains the following fields:

* **`reasoning_content`**: Text content of the model's reasoning process
* **`content`**: Text content of the model's response
* **`tool_calls`**: Tool call information, including function names and parameters

## Code Example

By setting the `tool_stream=True` parameter, you can enable streaming tool call functionality:

<Tabs>
  <Tab title="Python SDK">
    **Install SDK**

    ```bash  theme={null}
    # Install latest version
    pip install zai-sdk

    # Or specify version
    pip install zai-sdk==0.1.0
    ```

    **Verify Installation**

    ```python  theme={null}
    import zai
    print(zai.__version__)
    ```

    **Complete Example**

    ```python  theme={null}
    from zai import ZaiClient

    # Initialize client
    client = ZaiClient(api_key='Your API key')

    # Create streaming tool call request
    response = client.chat.completions.create(
        model="glm-4.6",  # Use model that supports tool calling
        messages=[
            {"role": "user", "content": "How's the weather in Beijing?"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get current weather conditions for a specified location",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string", "description": "City, e.g.: Beijing, Shanghai"},
                            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                        },
                        "required": ["location"]
                    }
                }
            }
        ],
        stream=True,        # Enable streaming output
        tool_stream=True    # Enable tool call streaming output
    )

    # Initialize variables to collect streaming data
    reasoning_content = ""      # Reasoning process content
    content = ""               # Response content
    final_tool_calls = {}      # Tool call information
    reasoning_started = False  # Reasoning process start flag
    content_started = False    # Content output start flag

    # Process streaming response
    for chunk in response:
        if not chunk.choices:
            continue

        delta = chunk.choices[0].delta

        # Handle streaming reasoning process output
        if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
            if not reasoning_started and delta.reasoning_content.strip():
                print("\n🧠 Thinking Process:")
                reasoning_started = True
            reasoning_content += delta.reasoning_content
            print(delta.reasoning_content, end="", flush=True)

        # Handle streaming response content output
        if hasattr(delta, 'content') and delta.content:
            if not content_started and delta.content.strip():
                print("\n\n💬 Response Content:")
                content_started = True
            content += delta.content
            print(delta.content, end="", flush=True)

        # Handle streaming tool call information
        if delta.tool_calls:
            for tool_call in delta.tool_calls:
                index = tool_call.index
                if index not in final_tool_calls:
                    # New tool call
                    final_tool_calls[index] = tool_call
                    final_tool_calls[index].function.arguments = tool_call.function.arguments
                else:
                    # Append tool call parameters (streaming construction)
                    final_tool_calls[index].function.arguments += tool_call.function.arguments

    # Output final tool call information
    if final_tool_calls:
        print("\n📋 Function Calls Triggered:")
        for index, tool_call in final_tool_calls.items():
            print(f"  {index}: Function Name: {tool_call.function.name}, Parameters: {tool_call.function.arguments}")
    ```
  </Tab>
</Tabs>

## Use Cases

<CardGroup cols={2}>
  <Card title="Intelligent Customer Service System" icon="headset">
    * Real-time display of query progress
    * Improve waiting experience
  </Card>

  <Card title="Code Assistant" icon="code">
    * Real-time code analysis process
    * Display tool call chain
  </Card>
</CardGroup>


---

> To find navigation and other pages in this documentation, fetch the llms.txt file at: https://docs.z.ai/llms.txt# Thinking Mode

> GLM-4.7 offers multiple thinking modes for different scenarios. The sections below explain how to enable each mode, key considerations, and example usage.

## **Default Thinking Behaviour**

Thinking is activated by default in GLM-4.7, different from the default hybrid thinking in GLM-4.6.

> If you want to disable thinking, use:

```bash  theme={null}
"thinking": {
    "type": "disabled"
}
```

## **Interleaved thinking**

We support **interleaved thinking** by default (supported since GLM-4.5), allowing GLM to think between tool calls and after receiving tool results. This enables more complex, step-by-step reasoning: interpreting each tool output before deciding what to do next, chaining multiple tool calls with reasoning steps, and making finer-grained decisions based on intermediate results.

<Tip>
  When using interleaved thinking with tools, **thinking blocks should be explicitly preserved and returned together with the tool results.**
</Tip>

The detailed interleaved thinking process is as follows.

![Description](https://cdn.bigmodel.cn/markdown/1766025484368img_v3_02t3_4677ac48-b748-44d8-a56f-8cbd599b51ag.jpg?attname=img_v3_02t3_4677ac48-b748-44d8-a56f-8cbd599b51ag.jpg)

## **Preserved thinking**

**GLM-4.7 introduces a new capability** in coding scenarios: the model can retain **reasoning content from previous assistant turns** in the context. This helps preserve reasoning continuity and conversation integrity, improves model performance, and increases cache hit rates—saving tokens in real tasks.

<Check>
  This capability is **enabled by default** on the **Coding Plan endpoint** and **disabled by default** on the **standard API endpoint**. If you want to enable **Preserved Thinking** in your product (primarily recommended for coding/agent scenarios), you can turn it on for the API endpoint by setting **"clear\_thinking": false**, and **you must return the complete**, unmodified reasoning\_content back to the API.

  All consecutive reasoning\_content blocks must **exactly match the original sequence** generated by the model during the initial request. Do not reorder or edit these blocks; otherwise, performance may degrade and cache hit rates may be affected.
</Check>

The detailed Preserved thinking process is as follows.

![Description](https://cdn.bigmodel.cn/markdown/176641919972020251222-235942.jpeg?attname=20251222-235942.jpeg)

## Turn-level Thinking

“Turn-level Thinking” is a capability that **lets you control reasoning computation on a per-turn basis**: within the same session, each request can independently choose to enable or disable thinking. This is a new capability introduced in GLM-4.7, with the following advantages:

* **More flexible cost/latency control:** For lightweight turns like “asking a fact” or “tweaking wording,” you can disable thinking to get faster responses; for heavier tasks like “complex planning,” “multi-constraint reasoning,” or “code debugging,” you can enable thinking to improve accuracy and stability.
* **Smoother multi-turn experience:** The thinking switch can be toggled at any point within a session. The model stays coherent across turns and keeps a consistent output style, making it feel “smarter when things are hard, faster when things are simple.”
* **Better for agent/tool-use scenarios:** On turns that require quick tool execution, you can reduce reasoning overhead; on turns that require making decisions based on tool results, you can turn on deeper thinking—dynamically balancing efficiency and quality.

## Example Usage

This applies to both **Interleaved Thinking** and **Preserved Thinking**—no manual differentiation is required. **Remember to return the historical** `reasoning_content`**to keep the reasoning coherent.**

```python  theme={null}
""""Interleaved Thinking + Tool Calling Example"""

import json
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="https://api.z.ai/api/paas/v4/",
)

tools = [{"type": "function", "function": {
    "name": "get_weather",
    "description": "Get weather information",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}}]

messages = [
    {"role": "system", "content": "You are an assistant"},
    {"role": "user", "content": "What's the weather like in Beijing?"},
]

# Round 1: the model reasons and then calls a tool
response = client.chat.completions.create(model="glm-4.7", messages=messages, tools=tools, stream=True, extra_body={
        "thinking":{
        "type":"enabled",
        "clear_thinking": False  # False for Preserved Thinking
    }})
reasoning, content, tool_calls = "", "", []
for chunk in response:
    delta = chunk.choices[0].delta
    if hasattr(delta, "reasoning_content") and delta.reasoning_content:
        reasoning += delta.reasoning_content
    if hasattr(delta, "content") and delta.content:
        content += delta.content
    if hasattr(delta, "tool_calls") and delta.tool_calls:
        for tc in delta.tool_calls:
            if tc.index >= len(tool_calls):
                tool_calls.append({"id": tc.id, "function": {"name": "", "arguments": ""}})
            if tc.function.name:
                tool_calls[tc.index]["function"]["name"] = tc.function.name
            if tc.function.arguments:
                tool_calls[tc.index]["function"]["arguments"] += tc.function.arguments

print(f"Reasoning: {reasoning}\nTool calls: {tool_calls}")

# Key: return reasoning_content to keep the reasoning coherent
messages.append({"role": "assistant", "content": content, "reasoning_content": reasoning,
                 "tool_calls": [{"id": tc["id"], "type": "function", "function": tc["function"]} for tc in tool_calls]})
messages.append({"role": "tool", "tool_call_id": tool_calls[0]["id"],
                 "content": json.dumps({"weather": "Sunny", "temp": "25°C"})})

# Round 2: the model continues reasoning based on the tool result and responds
response = client.chat.completions.create(model="glm-4.7", messages=messages, tools=tools, stream=True, extra_body={
        "thinking":{
        "type":"enabled",
        "clear_thinking": False # False for Preserved Thinking
    }})
reasoning, content = "", ""
for chunk in response:
    delta = chunk.choices[0].delta
    if hasattr(delta, "reasoning_content") and delta.reasoning_content:
        reasoning += delta.reasoning_content
    if hasattr(delta, "content") and delta.content:
        content += delta.content

print(f"Reasoning: {reasoning}\nReply: {content}")
```


---

> To find navigation and other pages in this documentation, fetch the llms.txt file at: https://docs.z.ai/llms.txt