/* Copyright (c) 2020, VRAI Labs and/or its affiliates. All rights reserved.
 *
 * This software is licensed under the Apache License, Version 2.0 (the
 * "License") as published by the Apache Software Foundation.
 *
 * You may not use this file except in compliance with the License. You may
 * obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 */

import { PROCESS_STATE, ProcessState } from "./processState";
import { package_version } from "./version";
import AntiCSRF from "./antiCsrf";
import IdRefreshToken from "./idRefreshToken";
import getLock from "./locking";

declare let global: any;

/**
 * @description returns true if retry, else false is session has expired completely.
 */
export async function handleUnauthorised(
    refreshAPI: string | undefined,
    preRequestIdToken: string | undefined,
    refreshAPICustomHeaders: any,
    sessionExpiredStatusCode: number
): Promise<boolean> {
    if (refreshAPI === undefined) {
        throw Error("Please define refresh token API in the init function");
    }
    if (preRequestIdToken === undefined) {
        return (await IdRefreshToken.getToken()) !== undefined;
    }
    let result = await onUnauthorisedResponse(
        refreshAPI,
        preRequestIdToken,
        refreshAPICustomHeaders,
        sessionExpiredStatusCode
    );
    if (result.result === "SESSION_EXPIRED") {
        return false;
    } else if (result.result === "API_ERROR") {
        throw result.error;
    }
    return true;
}

export function getDomainFromUrl(url: string): string {
    // if (window.fetch === undefined) {
    //     // we are testing
    //     return "http://localhost:8888";
    // }
    if (url.startsWith("https://") || url.startsWith("http://")) {
        return url
            .split("/")
            .filter((_, i) => i <= 2)
            .join("/");
    } else {
        throw new Error("Please make sure that the provided URL starts with http:// or https://");
    }
}

/**
 * @class AuthHttpRequest
 * @description wrapper for common http methods.
 */
export default class AuthHttpRequest {
    private static refreshTokenUrl: string | undefined;
    private static sessionExpiredStatusCode = 401;
    private static initCalled = false;
    static originalFetch: any;
    private static apiDomain = "";
    private static viaInterceptor: boolean | undefined;
    private static refreshAPICustomHeaders: any;

    static init(options: {
        refreshTokenUrl: string;
        viaInterceptor?: boolean | null;
        refreshAPICustomHeaders?: any;
        sessionExpiredStatusCode?: number;
    }) {
        let { refreshTokenUrl, viaInterceptor, refreshAPICustomHeaders, sessionExpiredStatusCode } = options;
        if (viaInterceptor === undefined || viaInterceptor === null) {
            if (AuthHttpRequest.viaInterceptor === undefined) {
                viaInterceptor = viaInterceptor === undefined;
                // if user uses this function, viaInterceptor will be undefined, in which case, they will by default have it on
                // if axios calls this function, then viaInterceptor will be null, in which case, no interception from fetch will happen
            } else {
                viaInterceptor = AuthHttpRequest.viaInterceptor;
            }
        }
        AuthHttpRequest.refreshTokenUrl = refreshTokenUrl;
        AuthHttpRequest.refreshAPICustomHeaders = refreshAPICustomHeaders === undefined ? {} : refreshAPICustomHeaders;
        if (sessionExpiredStatusCode !== undefined) {
            AuthHttpRequest.sessionExpiredStatusCode = sessionExpiredStatusCode;
        }
        let env: any = global;
        if (AuthHttpRequest.originalFetch === undefined) {
            AuthHttpRequest.originalFetch = env.fetch.bind(env);
        }
        if (viaInterceptor) {
            env.fetch = (url: RequestInfo, config?: RequestInit): Promise<Response> => {
                return AuthHttpRequest.fetch(url, config);
            };
        }
        AuthHttpRequest.viaInterceptor = viaInterceptor;
        AuthHttpRequest.apiDomain = getDomainFromUrl(refreshTokenUrl);
        AuthHttpRequest.initCalled = true;
    }

    /**
     * @description sends the actual http request and returns a response if successful/
     * If not successful due to session expiry reasons, it
     * attempts to call the refresh token API and if that is successful, calls this API again.
     * @throws Error
     */
    private static doRequest = async (
        httpCall: (config?: RequestInit) => Promise<Response>,
        config?: RequestInit,
        url?: any
    ): Promise<Response> => {
        if (!AuthHttpRequest.initCalled) {
            throw Error("init function not called");
        }
        if (
            typeof url === "string" &&
            getDomainFromUrl(url) !== AuthHttpRequest.apiDomain &&
            AuthHttpRequest.viaInterceptor
        ) {
            // this check means that if you are using fetch via inteceptor, then we only do the refresh steps if you are calling your APIs.
            return await httpCall(config);
        }
        if (AuthHttpRequest.viaInterceptor) {
            ProcessState.getInstance().addState(PROCESS_STATE.CALLING_INTERCEPTION_REQUEST);
        }
        try {
            let throwError = false;
            let returnObj = undefined;
            while (true) {
                // we read this here so that if there is a session expiry error, then we can compare this value (that caused the error) with the value after the request is sent.
                // to avoid race conditions
                const preRequestIdToken = await IdRefreshToken.getToken();
                const antiCsrfToken = await AntiCSRF.getToken(preRequestIdToken);
                let configWithAntiCsrf: RequestInit | undefined = config;
                if (antiCsrfToken !== undefined) {
                    configWithAntiCsrf = {
                        ...configWithAntiCsrf,
                        headers:
                            configWithAntiCsrf === undefined
                                ? {
                                      "anti-csrf": antiCsrfToken
                                  }
                                : {
                                      ...configWithAntiCsrf.headers,
                                      "anti-csrf": antiCsrfToken
                                  }
                    };
                }

                // Add package info to headers
                configWithAntiCsrf = {
                    ...configWithAntiCsrf,
                    headers:
                        configWithAntiCsrf === undefined
                            ? {
                                  "supertokens-sdk-name": "react-native",
                                  "supertokens-sdk-version": package_version
                              }
                            : {
                                  ...configWithAntiCsrf.headers,
                                  "supertokens-sdk-name": "react-native",
                                  "supertokens-sdk-version": package_version
                              }
                };
                try {
                    let response = await httpCall(configWithAntiCsrf);
                    response.headers.forEach(async (value: string, key: string) => {
                        if (key.toString() === "id-refresh-token") {
                            await IdRefreshToken.setToken(value);
                        }
                    });
                    if (response.status === AuthHttpRequest.sessionExpiredStatusCode) {
                        let retry = await handleUnauthorised(
                            AuthHttpRequest.refreshTokenUrl,
                            preRequestIdToken,
                            AuthHttpRequest.refreshAPICustomHeaders,
                            AuthHttpRequest.sessionExpiredStatusCode
                        );
                        if (!retry) {
                            returnObj = response;
                            break;
                        }
                    } else {
                        response.headers.forEach(async (value: string, key: string) => {
                            if (key.toString() === "anti-csrf") {
                                await AntiCSRF.setToken(value, await IdRefreshToken.getToken());
                            }
                        });
                        return response;
                    }
                } catch (err) {
                    if (err.status === AuthHttpRequest.sessionExpiredStatusCode) {
                        let retry = await handleUnauthorised(
                            AuthHttpRequest.refreshTokenUrl,
                            preRequestIdToken,
                            AuthHttpRequest.refreshAPICustomHeaders,
                            AuthHttpRequest.sessionExpiredStatusCode
                        );
                        if (!retry) {
                            throwError = true;
                            returnObj = err;
                            break;
                        }
                    } else {
                        throw err;
                    }
                }
            }
            // if it comes here, means we breaked. which happens only if we have logged out.
            if (throwError) {
                throw returnObj;
            } else {
                return returnObj;
            }
        } finally {
            if ((await IdRefreshToken.getToken()) === undefined) {
                await AntiCSRF.removeToken();
            }
        }
    };

    static get = async (url: RequestInfo, config?: RequestInit) => {
        return await AuthHttpRequest.fetch(url, {
            method: "GET",
            ...config
        });
    };

    static post = async (url: RequestInfo, config?: RequestInit) => {
        return await AuthHttpRequest.fetch(url, {
            method: "POST",
            ...config
        });
    };

    static delete = async (url: RequestInfo, config?: RequestInit) => {
        return await AuthHttpRequest.fetch(url, {
            method: "DELETE",
            ...config
        });
    };

    static put = async (url: RequestInfo, config?: RequestInit) => {
        return await AuthHttpRequest.fetch(url, {
            method: "PUT",
            ...config
        });
    };

    static fetch = async (url: RequestInfo, config?: RequestInit) => {
        return await AuthHttpRequest.doRequest(
            (config?: RequestInit) => {
                return AuthHttpRequest.originalFetch(url, {
                    ...config
                });
            },
            config,
            url
        );
    };

    static doesSessionExist = async () => {
        return (await IdRefreshToken.getToken()) !== undefined;
    };
}

const LOCK_NAME = "REFRESH_TOKEN_USE";

async function onUnauthorisedResponse(
    refreshTokenUrl: string,
    preRequestIdToken: string,
    refreshAPICustomHeaders: any,
    sessionExpiredStatusCode: number
): Promise<{ result: "SESSION_EXPIRED" } | { result: "API_ERROR"; error: any } | { result: "RETRY" }> {
    let lock = getLock();
    // TODO: lock natively
    await lock.lock(LOCK_NAME);
    try {
        let postLockID = await IdRefreshToken.getToken();
        if (postLockID === undefined) {
            return { result: "SESSION_EXPIRED" };
        }
        if (postLockID !== preRequestIdToken) {
            // means that some other process has already called this API and succeeded. so we need to call it again
            return { result: "RETRY" };
        }
        const antiCsrfToken = await AntiCSRF.getToken(preRequestIdToken);
        let headers: any = {
            ...refreshAPICustomHeaders,
            "supertokens-sdk-name": "react-native",
            "supertokens-sdk-version": package_version
        };
        if (antiCsrfToken !== undefined) {
            headers = {
                ...headers,
                "anti-csrf": antiCsrfToken
            };
        }
        let response = await AuthHttpRequest.originalFetch(refreshTokenUrl, {
            method: "post",
            credentials: "include",
            headers
        });
        let removeIdRefreshToken = true;
        response.headers.forEach(async (value: string, key: string) => {
            if (key.toString() === "id-refresh-token") {
                await IdRefreshToken.setToken(value);
                removeIdRefreshToken = false;
            }
        });
        if (response.status === sessionExpiredStatusCode) {
            // there is a case where frontend still has id refresh token, but backend doesn't get it. In this event, session expired error will be thrown and the frontend should remove this token
            if (removeIdRefreshToken) {
                await IdRefreshToken.setToken("remove");
            }
        }
        if (response.status >= 300) {
            throw response;
        }
        if ((await IdRefreshToken.getToken()) === undefined) {
            // removed by server. So we logout
            return { result: "SESSION_EXPIRED" };
        }
        response.headers.forEach(async (value: any, key: any) => {
            if (key.toString() === "anti-csrf") {
                await AntiCSRF.setToken(value, await IdRefreshToken.getToken());
            }
        });
        return { result: "RETRY" };
    } catch (error) {
        if ((await IdRefreshToken.getToken()) === undefined) {
            // removed by server.
            return { result: "SESSION_EXPIRED" };
        }
        return { result: "API_ERROR", error };
    } finally {
        // TODO: unlock natively
        lock.unlock(LOCK_NAME);
    }
}
