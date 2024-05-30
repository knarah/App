import MockedOnyx from 'react-native-onyx';
import type {ValueOf} from 'type-fest';
import type {ApiRequestCommandParameters, ReadCommand, WriteCommand} from '@libs/API/types';
import CONST from '@src/CONST';
import * as PersistedRequests from '@src/libs/actions/PersistedRequests';
import * as API from '@src/libs/API';
import HttpUtils from '@src/libs/HttpUtils';
import * as MainQueue from '@src/libs/Network/MainQueue';
import * as NetworkStore from '@src/libs/Network/NetworkStore';
import * as SequentialQueue from '@src/libs/Network/SequentialQueue';
import * as Request from '@src/libs/Request';
import * as RequestThrottle from '@src/libs/RequestThrottle';
import ONYXKEYS from '@src/ONYXKEYS';
import type ReactNativeOnyxMock from '../../__mocks__/react-native-onyx';
import * as TestHelper from '../utils/TestHelper';
import waitForBatchedUpdates from '../utils/waitForBatchedUpdates';
import waitForNetworkPromises from '../utils/waitForNetworkPromises';

const Onyx = MockedOnyx as typeof ReactNativeOnyxMock;

jest.mock('@src/libs/Log');

Onyx.init({
    keys: ONYXKEYS,
});

type Response = {
    ok?: boolean;
    status?: ValueOf<typeof CONST.HTTP_STATUS> | ValueOf<typeof CONST.JSON_CODE>;
    jsonCode?: ValueOf<typeof CONST.JSON_CODE>;
    json?: () => Promise<Response>;
    title?: ValueOf<typeof CONST.ERROR_TITLE>;
    type?: ValueOf<typeof CONST.ERROR_TYPE>;
};

type XhrCalls = Array<{
    resolve: (value: Response | PromiseLike<Response>) => void;
    reject: (value: unknown) => void;
}>;

const originalXHR = HttpUtils.xhr;

beforeEach(() => {
    global.fetch = TestHelper.getGlobalFetchMock();
    HttpUtils.xhr = originalXHR;
    MainQueue.clear();
    HttpUtils.cancelPendingRequests();
    PersistedRequests.clear();
    NetworkStore.checkRequiredData();

    // Wait for any Log command to finish and Onyx to fully clear
    return waitForBatchedUpdates()
        .then(() => Onyx.clear())
        .then(waitForBatchedUpdates);
});

afterEach(() => {
    NetworkStore.resetHasReadRequiredDataFromStorage();
    Onyx.addDelayToConnectCallback(0);
    jest.clearAllMocks();
});

/* eslint-disable rulesdir/no-multiple-api-calls */
/* eslint-disable rulesdir/no-api-side-effects-method */
describe('APITests', () => {
    test('All writes should be persisted while offline', () => {
        // We don't expect calls `xhr` so we make the test fail if such call is made
        const xhr = jest.spyOn(HttpUtils, 'xhr').mockRejectedValue(new Error('Unexpected xhr call'));

        // Given we're offline
        return Onyx.set(ONYXKEYS.NETWORK, {isOffline: true, isBackendReachable: false})
            .then(() => {
                // When API Writes and Reads are called
                API.write<WriteCommand>('mock command' as WriteCommand, {param1: 'value1'} as ApiRequestCommandParameters[WriteCommand]);
                API.read<ReadCommand>('mock command' as ReadCommand, {param2: 'value2'} as unknown as ApiRequestCommandParameters[ReadCommand]);
                API.write<WriteCommand>('mock command' as WriteCommand, {param3: 'value3'} as ApiRequestCommandParameters[WriteCommand]);
                return waitForBatchedUpdates();
            })
            .then(() => {
                // Then `xhr` should only be called for the read (where it would not succeed in real life) and write requests should be persisted to storage
                expect(xhr).toHaveBeenCalledTimes(1);

                const persisted = PersistedRequests.getAll();
                expect(persisted).toEqual([
                    expect.objectContaining({command: 'mock command', data: expect.objectContaining({param1: 'value1'})}),
                    expect.objectContaining({command: 'mock command', data: expect.objectContaining({param3: 'value3'})}),
                ]);

                PersistedRequests.clear();
                return waitForBatchedUpdates();
            })
            .then(() => {
                expect(PersistedRequests.getAll()).toEqual([]);
            });
    });

    test('Write requests should resume when we are online', () => {
        // We're setting up a basic case where all requests succeed when we resume connectivity
        const xhr = jest.spyOn(HttpUtils, 'xhr').mockResolvedValue({jsonCode: CONST.JSON_CODE.SUCCESS});

        // Given we have some requests made while we're offline
        return (
            Onyx.multiSet({
                [ONYXKEYS.NETWORK]: {isOffline: true, isBackendReachable: false},
                [ONYXKEYS.CREDENTIALS]: {autoGeneratedLogin: 'test', autoGeneratedPassword: 'passwd'},
                [ONYXKEYS.SESSION]: {authToken: 'testToken'},
            })
                .then(() => {
                    // When API Write commands are made
                    API.write<WriteCommand>('mock command' as WriteCommand, {param1: 'value1'} as ApiRequestCommandParameters[WriteCommand]);
                    API.write<WriteCommand>('mock command' as WriteCommand, {param2: 'value2'} as ApiRequestCommandParameters[WriteCommand]);
                    return waitForBatchedUpdates();
                })
                .then(() => {
                    const persisted = PersistedRequests.getAll();
                    expect(persisted).toHaveLength(2);
                })

                // When we resume connectivity
                .then(() => Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true}))
                .then(waitForBatchedUpdates)
                .then(() => {
                    expect(NetworkStore.isOffline()).toBe(false);
                    expect(SequentialQueue.isRunning()).toBe(false);

                    // Then `xhr` should be called with expected data, and the persisted queue should be empty
                    expect(xhr).toHaveBeenCalledTimes(2);
                    expect(xhr.mock.calls).toEqual([
                        expect.arrayContaining(['mock command', expect.objectContaining({param1: 'value1'})]),
                        expect.arrayContaining(['mock command', expect.objectContaining({param2: 'value2'})]),
                    ]);

                    const persisted = PersistedRequests.getAll();
                    expect(persisted).toEqual([]);
                })
        );
    });

    test('Write request should not be cleared until a backend response occurs', () => {
        // We're setting up xhr handler that will resolve calls programmatically
        const xhrCalls: XhrCalls = [];
        const promises: Array<Promise<Response>> = [];

        jest.spyOn(HttpUtils, 'xhr').mockImplementation(() => {
            promises.push(
                new Promise((resolve, reject) => {
                    xhrCalls.push({resolve, reject});
                }),
            );

            return promises.slice(-1)[0];
        });

        // Given we have some requests made while we're offline
        return (
            Onyx.set(ONYXKEYS.NETWORK, {isOffline: true, isBackendReachable: false})
                .then(() => {
                    // When API Write commands are made
                    API.write<WriteCommand>('mock command' as WriteCommand, {param1: 'value1'} as ApiRequestCommandParameters[WriteCommand]);
                    API.write<WriteCommand>('mock command' as WriteCommand, {param2: 'value2'} as ApiRequestCommandParameters[WriteCommand]);
                    return waitForBatchedUpdates();
                })

                // When we resume connectivity
                .then(() => Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true}))
                .then(waitForBatchedUpdates)
                .then(() => {
                    // Then requests should remain persisted until the xhr call is resolved
                    expect(PersistedRequests.getAll().length).toEqual(2);

                    xhrCalls[0].resolve({jsonCode: CONST.JSON_CODE.SUCCESS});
                    return waitForBatchedUpdates();
                })
                .then(waitForBatchedUpdates)
                .then(() => {
                    expect(PersistedRequests.getAll().length).toEqual(1);
                    expect(PersistedRequests.getAll()).toEqual([expect.objectContaining({command: 'mock command', data: expect.objectContaining({param2: 'value2'})})]);

                    // When a request fails it should be retried
                    xhrCalls[1].reject(new Error(CONST.ERROR.FAILED_TO_FETCH));
                    return waitForBatchedUpdates();
                })
                .then(() => {
                    expect(PersistedRequests.getAll().length).toEqual(1);
                    expect(PersistedRequests.getAll()).toEqual([expect.objectContaining({command: 'mock command', data: expect.objectContaining({param2: 'value2'})})]);

                    // We need to advance past the request throttle back off timer because the request won't be retried until then
                    return new Promise((resolve) => {
                        setTimeout(resolve, CONST.NETWORK.MAX_RANDOM_RETRY_WAIT_TIME_MS);
                    }).then(waitForBatchedUpdates);
                })
                .then(() => {
                    // Finally, after it succeeds the queue should be empty
                    xhrCalls[2].resolve({jsonCode: CONST.JSON_CODE.SUCCESS});
                    return waitForBatchedUpdates();
                })
                .then(() => {
                    expect(PersistedRequests.getAll().length).toEqual(0);
                })
        );
    });

    // Given a retry response create a mock and run some expectations for retrying requests

    const retryExpectations = (response: Response) => {
        const successfulResponse: Response = {
            ok: true,
            jsonCode: CONST.JSON_CODE.SUCCESS,
            // We have to mock response.json() too
            json: () => Promise.resolve(successfulResponse),
        };

        // Given a mock where a retry response is returned twice before a successful response
        global.fetch = jest.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(response).mockResolvedValueOnce(successfulResponse);

        // Given we have a request made while we're offline
        return (
            Onyx.set(ONYXKEYS.NETWORK, {isOffline: true, isBackendReachable: false})
                .then(() => {
                    // When API Write commands are made
                    API.write<WriteCommand>('mock command' as WriteCommand, {param1: 'value1'} as ApiRequestCommandParameters[WriteCommand]);
                    return waitForNetworkPromises();
                })

                // When we resume connectivity
                .then(() => Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true}))
                .then(waitForBatchedUpdates)
                .then(() => {
                    // Then there has only been one request so far
                    expect(global.fetch).toHaveBeenCalledTimes(1);

                    // And we still have 1 persisted request since it failed
                    expect(PersistedRequests.getAll().length).toEqual(1);
                    expect(PersistedRequests.getAll()).toEqual([expect.objectContaining({command: 'mock command', data: expect.objectContaining({param1: 'value1'})})]);

                    // We let the SequentialQueue process again after its wait time
                    return new Promise((resolve) => {
                        setTimeout(resolve, RequestThrottle.getLastRequestWaitTime());
                    });
                })
                .then(() => {
                    // Then we have retried the failing request
                    expect(global.fetch).toHaveBeenCalledTimes(2);

                    // And we still have 1 persisted request since it failed
                    expect(PersistedRequests.getAll().length).toEqual(1);
                    expect(PersistedRequests.getAll()).toEqual([expect.objectContaining({command: 'mock command', data: expect.objectContaining({param1: 'value1'})})]);

                    // We let the SequentialQueue process again after its wait time
                    return new Promise((resolve) => {
                        setTimeout(resolve, RequestThrottle.getLastRequestWaitTime());
                    }).then(waitForBatchedUpdates);
                })
                .then(() => {
                    // Then the request is retried again
                    expect(global.fetch).toHaveBeenCalledTimes(3);

                    // The request succeeds so the queue is empty
                    expect(PersistedRequests.getAll().length).toEqual(0);
                })
        );
    };

    test.each([CONST.HTTP_STATUS.INTERNAL_SERVER_ERROR, CONST.HTTP_STATUS.BAD_GATEWAY, CONST.HTTP_STATUS.GATEWAY_TIMEOUT, CONST.HTTP_STATUS.UNKNOWN_ERROR])(
        'Write requests with http status %d are retried',

        // Given that a request resolves as not ok and with a particular http status
        // When we make a persisted request and the http status represents a server error then it is retried with exponential back off
        (httpStatus) => retryExpectations({ok: false, status: httpStatus}),
    );

    test('write requests are retried when Auth is down', () => {
        // Given the response data returned when auth is down
        const responseData: Response = {
            ok: true,
            status: CONST.JSON_CODE.SUCCESS,
            jsonCode: CONST.JSON_CODE.EXP_ERROR,
            title: CONST.ERROR_TITLE.SOCKET,
            type: CONST.ERROR_TYPE.SOCKET,
        };

        // We have to mock response.json() too
        const authIsDownResponse = {
            ...responseData,
            json: () => Promise.resolve(responseData),
        };

        // When we make a request and auth is down then we retry until it's back
        return retryExpectations(authIsDownResponse);
    });

    test('Write request can trigger reauthentication for anything retryable', () => {
        // We're setting up xhr handler that rejects once with a 407 code and again with success
        const xhr = jest
            .spyOn(HttpUtils, 'xhr')
            .mockResolvedValue({jsonCode: CONST.JSON_CODE.SUCCESS}) // Default
            .mockResolvedValueOnce({jsonCode: CONST.JSON_CODE.NOT_AUTHENTICATED}) // Initial call to test command return 407
            .mockResolvedValueOnce({jsonCode: CONST.JSON_CODE.SUCCESS}) // Call to Authenticate return 200
            .mockResolvedValueOnce({jsonCode: CONST.JSON_CODE.SUCCESS}); // Original command return 200

        // Given we have a request made while we're offline and we have credentials available to reauthenticate
        Onyx.merge(ONYXKEYS.CREDENTIALS, {autoGeneratedLogin: 'test', autoGeneratedPassword: 'passwd'});
        return (
            waitForBatchedUpdates()
                .then(() => Onyx.set(ONYXKEYS.NETWORK, {isOffline: true, isBackendReachable: false}))
                .then(() => {
                    API.write<WriteCommand>('Mock' as WriteCommand, {param1: 'value1'} as ApiRequestCommandParameters[WriteCommand]);
                    return waitForBatchedUpdates();
                })

                // When we resume connectivity
                .then(() => Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true}))
                .then(waitForBatchedUpdates)
                .then(() => {
                    const nonLogCalls = xhr.mock.calls.filter(([commandName]) => commandName !== 'Log');

                    // The request should be retried once and reauthenticate should be called the second time
                    // expect(xhr).toHaveBeenCalledTimes(3);
                    const [call1, call2, call3] = nonLogCalls;
                    const [commandName1] = call1;
                    const [commandName2] = call2;
                    const [commandName3] = call3;
                    expect(commandName1).toBe('Mock');
                    expect(commandName2).toBe('Authenticate');
                    expect(commandName3).toBe('Mock');
                })
        );
    });

    test('several actions made while offline will get added in the order they are created', () => {
        // Given offline state where all requests will eventualy succeed without issue
        const xhr = jest.spyOn(HttpUtils, 'xhr').mockResolvedValue({jsonCode: CONST.JSON_CODE.SUCCESS});
        return Onyx.multiSet({
            [ONYXKEYS.SESSION]: {authToken: 'anyToken'},
            [ONYXKEYS.NETWORK]: {isOffline: true, isBackendReachable: false},
            [ONYXKEYS.CREDENTIALS]: {autoGeneratedLogin: 'test_user', autoGeneratedPassword: 'psswd'},
        })
            .then(() => {
                // When we queue 6 persistable commands and one not persistable
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value1'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value2'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value3'} as ApiRequestCommandParameters[WriteCommand]);
                API.read<ReadCommand>('MockCommand' as ReadCommand, {content: 'not-persisted'} as unknown as ApiRequestCommandParameters[ReadCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value4'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value5'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value6'} as ApiRequestCommandParameters[WriteCommand]);

                return waitForBatchedUpdates();
            })
            .then(() => Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true}))
            .then(waitForBatchedUpdates)
            .then(() => {
                // Then expect all 7 calls to have been made and for the Writes to be made in the order that we made them
                // The read command would have been made first (and would have failed in real-life)
                expect(xhr.mock.calls.length).toBe(7);
                expect(xhr.mock.calls[0][1].content).toBe('not-persisted');
                expect(xhr.mock.calls[1][1].content).toBe('value1');
                expect(xhr.mock.calls[2][1].content).toBe('value2');
                expect(xhr.mock.calls[3][1].content).toBe('value3');
                expect(xhr.mock.calls[4][1].content).toBe('value4');
                expect(xhr.mock.calls[5][1].content).toBe('value5');
                expect(xhr.mock.calls[6][1].content).toBe('value6');
            });
    });

    test('several actions made while offline will get added in the order they are created when we need to reauthenticate', () => {
        // Given offline state where all requests will eventualy succeed without issue and assumed to be valid credentials
        const xhr = jest.spyOn(HttpUtils, 'xhr').mockResolvedValueOnce({jsonCode: CONST.JSON_CODE.NOT_AUTHENTICATED}).mockResolvedValue({jsonCode: CONST.JSON_CODE.SUCCESS});

        return Onyx.multiSet({
            [ONYXKEYS.NETWORK]: {isOffline: true, isBackendReachable: false},
            [ONYXKEYS.SESSION]: {authToken: 'test'},
            [ONYXKEYS.CREDENTIALS]: {autoGeneratedLogin: 'test', autoGeneratedPassword: 'passwd'},
        })
            .then(() => {
                // When we queue 6 persistable commands
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value1'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value2'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value3'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value4'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value5'} as ApiRequestCommandParameters[WriteCommand]);
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value6'} as ApiRequestCommandParameters[WriteCommand]);
                return waitForBatchedUpdates();
            })
            .then(() => Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true}))
            .then(waitForBatchedUpdates)
            .then(() => {
                // Then expect only 8 calls to have been made total and for them to be made in the order that we made them despite requiring reauthentication
                expect(xhr.mock.calls.length).toBe(8);
                expect(xhr.mock.calls[0][1].content).toBe('value1');

                // Our call to Authenticate will not have a "content" field
                expect(xhr.mock.calls[1][1].content).not.toBeDefined();

                // Rest of the calls have the expected params and are called in sequence
                expect(xhr.mock.calls[2][1].content).toBe('value1');
                expect(xhr.mock.calls[3][1].content).toBe('value2');
                expect(xhr.mock.calls[4][1].content).toBe('value3');
                expect(xhr.mock.calls[5][1].content).toBe('value4');
                expect(xhr.mock.calls[6][1].content).toBe('value5');
                expect(xhr.mock.calls[7][1].content).toBe('value6');
            });
    });

    test('Sequential queue will succeed if triggered while reauthentication via main queue is in progress', () => {
        // Given offline state where all requests will eventualy succeed without issue and assumed to be valid credentials
        const xhr = jest
            .spyOn(HttpUtils, 'xhr')
            .mockResolvedValueOnce({jsonCode: CONST.JSON_CODE.NOT_AUTHENTICATED})
            .mockResolvedValueOnce({jsonCode: CONST.JSON_CODE.NOT_AUTHENTICATED})
            .mockResolvedValue({jsonCode: CONST.JSON_CODE.SUCCESS, authToken: 'newToken'});

        return Onyx.multiSet({
            [ONYXKEYS.SESSION]: {authToken: 'oldToken'},
            [ONYXKEYS.NETWORK]: {isOffline: false, isBackendReachable: true},
            [ONYXKEYS.CREDENTIALS]: {autoGeneratedLogin: 'test_user', autoGeneratedPassword: 'psswd'},
        })
            .then(() => {
                // When we queue both non-persistable and persistable commands that will trigger reauthentication and go offline at the same time
                API.makeRequestWithSideEffects('AuthenticatePusher', {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    socket_id: 'socket_id',
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    channel_name: 'channel_name',
                    shouldRetry: false,
                    forceNetworkRequest: false,
                });

                Onyx.set(ONYXKEYS.NETWORK, {isOffline: true, isBackendReachable: false});
                expect(NetworkStore.isOffline()).toBe(false);
                expect(NetworkStore.isAuthenticating()).toBe(false);
                return waitForBatchedUpdates();
            })
            .then(() => {
                API.write('MockCommand' as WriteCommand, {});
                expect(PersistedRequests.getAll().length).toBe(1);
                expect(NetworkStore.isOffline()).toBe(true);
                expect(SequentialQueue.isRunning()).toBe(false);
                expect(NetworkStore.isAuthenticating()).toBe(false);

                // We should only have a single call at this point as the main queue is stopped since we've gone offline
                expect(xhr.mock.calls.length).toBe(1);

                waitForBatchedUpdates();

                // Come back from offline to trigger the sequential queue flush
                Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true});
            })
            .then(() => {
                // When we wait for the sequential queue to finish
                expect(SequentialQueue.isRunning()).toBe(true);
                return waitForBatchedUpdates();
            })
            .then(() => {
                // Then we should expect to see that...
                // The sequential queue has stopped
                expect(SequentialQueue.isRunning()).toBe(false);

                // All persisted requests have run
                expect(PersistedRequests.getAll().length).toBe(0);

                // We are not offline anymore
                expect(NetworkStore.isOffline()).toBe(false);

                // First call to xhr is the AuthenticatePusher request that could not call Authenticate because we went offline
                const [firstCommand] = xhr.mock.calls[0];
                expect(firstCommand).toBe('AuthenticatePusher');

                // Second call to xhr is the MockCommand that also failed with a 407
                const [secondCommand] = xhr.mock.calls[1];
                expect(secondCommand).toBe('MockCommand');

                // Third command should be the call to Authenticate
                const [thirdCommand] = xhr.mock.calls[2];
                expect(thirdCommand).toBe('Authenticate');

                const [fourthCommand] = xhr.mock.calls[3];
                expect(fourthCommand).toBe('MockCommand');

                // We are using the new authToken
                expect(NetworkStore.getAuthToken()).toBe('newToken');

                // We are no longer authenticating
                expect(NetworkStore.isAuthenticating()).toBe(false);
            });
    });

    test('Sequential queue will not run until credentials are read', () => {
        const xhr = jest.spyOn(HttpUtils, 'xhr');
        const processWithMiddleware = jest.spyOn(Request, 'processWithMiddleware');

        // Given a simulated a condition where the credentials have not yet been read from storage and we are offline
        return Onyx.multiSet({
            [ONYXKEYS.NETWORK]: {isOffline: true, isBackendReachable: false},
            [ONYXKEYS.CREDENTIALS]: {},
            [ONYXKEYS.SESSION]: null,
        })
            .then(() => {
                expect(NetworkStore.isOffline()).toBe(true);

                NetworkStore.resetHasReadRequiredDataFromStorage();

                // And queue a Write request while offline
                API.write<WriteCommand>('MockCommand' as WriteCommand, {content: 'value1'} as ApiRequestCommandParameters[WriteCommand]);

                // Then we should expect the request to get persisted
                expect(PersistedRequests.getAll().length).toBe(1);

                // When we go online and wait for promises to resolve
                return Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true});
            })
            .then(waitForBatchedUpdates)
            .then(() => {
                expect(processWithMiddleware).toHaveBeenCalled();

                // Then we should not expect XHR to run
                expect(xhr).not.toHaveBeenCalled();

                // When we set our credentials and authToken
                return Onyx.multiSet({
                    [ONYXKEYS.CREDENTIALS]: {autoGeneratedLogin: 'test_user', autoGeneratedPassword: 'psswd'},
                    [ONYXKEYS.SESSION]: {authToken: 'oldToken'},
                });
            })
            .then(waitForBatchedUpdates)
            .then(() => {
                // Then we should expect XHR to run
                expect(xhr).toHaveBeenCalled();
            });
    });

    test('Write request will move directly to the SequentialQueue when we are online and block non-Write requests', () => {
        const xhr = jest.spyOn(HttpUtils, 'xhr');
        return Onyx.set(ONYXKEYS.NETWORK, {isOffline: false, isBackendReachable: true})
            .then(() => {
                // GIVEN that we are online
                expect(NetworkStore.isOffline()).toBe(false);

                // WHEN we make a request that should be retried, one that should not, and another that should
                API.write('MockCommandOne' as WriteCommand, {});
                API.read('MockCommandTwo' as ReadCommand, null);
                API.write('MockCommandThree' as WriteCommand, {});

                // THEN the retryable requests should immediately be added to the persisted requests
                expect(PersistedRequests.getAll().length).toBe(2);

                // WHEN we wait for the queue to run and finish processing
                return waitForBatchedUpdates();
            })
            .then(() => {
                // THEN the queue should be stopped and there should be no more requests to run
                expect(SequentialQueue.isRunning()).toBe(false);
                expect(PersistedRequests.getAll().length).toBe(0);

                // And our Write request should run before our non persistable one in a blocking way
                const firstRequest = xhr.mock.calls[0];
                const [firstRequestCommandName] = firstRequest;
                expect(firstRequestCommandName).toBe('MockCommandOne');

                const secondRequest = xhr.mock.calls[1];
                const [secondRequestCommandName] = secondRequest;
                expect(secondRequestCommandName).toBe('MockCommandThree');

                // WHEN we advance the main queue timer and wait for promises
                return new Promise((resolve) => {
                    setTimeout(resolve, CONST.NETWORK.PROCESS_REQUEST_DELAY_MS);
                });
            })
            .then(() => {
                // THEN we should see that our third (non-persistable) request has run last
                const thirdRequest = xhr.mock.calls[2];
                const [thirdRequestCommandName] = thirdRequest;
                expect(thirdRequestCommandName).toBe('MockCommandTwo');
            });
    });
});
