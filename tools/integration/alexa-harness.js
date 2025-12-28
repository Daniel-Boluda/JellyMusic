const makeResponseBuilder = () => {
    const state = {
        speech: null,
        reprompt: null,
        shouldEndSession: undefined,
        directives: [],
        audioPlayCalls: []
    };

    return {
        _state: state,
        speak(text) {
            state.speech = String(text);
            return this;
        },
        reprompt(text) {
            state.reprompt = String(text);
            return this;
        },
        withShouldEndSession(flag) {
            state.shouldEndSession = Boolean(flag);
            return this;
        },
        addDirective(directive) {
            state.directives.push(directive);
            return this;
        },
        addAudioPlayerPlayDirective(playBehavior, url, token, offsetInMilliseconds, expectedPreviousToken, metadata) {
            state.audioPlayCalls.push({ playBehavior, url, token, offsetInMilliseconds, expectedPreviousToken, metadata });
            state.directives.push({
                type: 'AudioPlayer.Play',
                playBehavior,
                audioItem: {
                    stream: {
                        url,
                        token,
                        expectedPreviousToken,
                        offsetInMilliseconds
                    },
                    metadata
                }
            });
            return this;
        },
        getResponse() {
            const res = {
                shouldEndSession: state.shouldEndSession,
                directives: state.directives.length ? state.directives : undefined,
                outputSpeech: state.speech ? { type: 'PlainText', text: state.speech } : undefined,
                reprompt: state.reprompt ? { outputSpeech: { type: 'PlainText', text: state.reprompt } } : undefined
            };
            return res;
        }
    };
};

const makeAttributesManager = (seedPersistent = {}) => {
    let session = {};
    let persistent = JSON.parse(JSON.stringify(seedPersistent || {}));

    return {
        getSessionAttributes() { return session; },
        setSessionAttributes(next) { session = next || {}; },
        async getPersistentAttributes() { return persistent; },
        setPersistentAttributes(next) { persistent = next || {}; },
        async savePersistentAttributes() { /* in-memory */ }
    };
};

const makeHandlerInput = ({ intentName, slots = {}, locale = 'es-ES', deviceId = 'integration-device', seedPersistent } = {}) => {
    const normalizedSlots = {};
    for (const [k, v] of Object.entries(slots || {})) {
        if (v === undefined || v === null) continue;
        normalizedSlots[k] = v;
    }

    return {
        requestEnvelope: {
            request: {
                type: 'IntentRequest',
                locale,
                intent: {
                    name: intentName,
                    slots: normalizedSlots
                }
            },
            context: {
                System: {
                    device: {
                        deviceId,
                        supportedInterfaces: { VideoApp: {} }
                    }
                },
                AudioPlayer: {
                    offsetInMilliseconds: 0
                }
            }
        },
        responseBuilder: makeResponseBuilder(),
        attributesManager: makeAttributesManager(seedPersistent)
    };
};

module.exports = {
    makeHandlerInput
};
