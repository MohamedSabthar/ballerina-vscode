import ballerina/ai;
import ballerina/workflow;

final ai:Wso2ModelProvider keyedModel = check new ("http://localhost:9099", "test-token");

# Agent declared in the 1.0 keyed form: `chat` declares a response, `bill` does not.
final workflow:DurableAgent keyedAgent = check new ({
    systemPrompt: {role: "Support", instructions: "Help."},
    model: keyedModel,
    events: {
        chat: {request: string, response: string},
        bill: {request: json}
    },
    humanTasks: {
        approve: {userRoles: "MANAGER"}
    }
});

function sendToKeyedAgent(string instanceId) returns error? {

}

final workflow:EventConfig noticeConfig = {request: json, response: string};

# A channel configured through a reference: whether it answers is not readable from the declaration.
final workflow:DurableAgent refAgent = check new ({
    systemPrompt: {role: "Notices", instructions: "Relay notices."},
    model: keyedModel,
    events: {notice: noticeConfig}
});

# A project on a keyed release whose agent still carries empty lists: the first entry rewrites them as maps.
final workflow:DurableAgent emptyAgent = check new ({
    systemPrompt: {role: "Inbox", instructions: "Route mail."},
    model: keyedModel,
    events: [],
    humanTasks: []
});
