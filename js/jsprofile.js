(function(root, factory) {
    'use strict';
    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.

    /* istanbul ignore next */
    if (typeof define === 'function' && define.amd) {
        define('js-profiler', [], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory(root);
    } else {
        root.JSProfiler = factory(root);
    }
}(this, function JSProfiler(global) {
    if(typeof(global.Proxy) != "function") {
        console.log("JSProfiler only works with browsers that support the ECMA6 specification.");
        return {};
    }

    var _options = {
        startPoint: "global",
        maxDepth: 2,
        exceptFunctions: [
            "requestAnimationFrame",
            "getComputedStyle"
        ],
        exceptObjects: [
            "window",
            "opener",
            "top",
            "location",
            "document",
            "frames",
            "self",
            "parent",
            "constructor",
            "JSProfiler"
        ]
    };
    var _initialize = false;
    var _running = false;

    var PROFILES = [];
    var PROFILE_SEQUENCE = {};
    var ACTIVE_QUEUE = [];

    function createProxy(parent, name, obj, callerObj) {
        var fullName = getFullName({ parent: parent, name: name });

        if(PROFILE_SEQUENCE[fullName] == undefined) {
            PROFILE_SEQUENCE[fullName] = 0;
        }

        var getProxyParameters = function(args, queue) {
            var parameterList = [];

            for(var i = 0; i < args.length; i++) {
                if(typeof(args[i]) == "function") {
                    parameterList[i] = {
                        type: "function",
                        value: "callback"
                    };

                    args[i] = createProxy(parent, "__callback__", args[i], queue);
                } else if(typeof(args[i]) == "object") {
                    // TODO: 차후 다시 구현하기 (value를 문자열로 만드는것)
                    parameterList[i] = {
                        type: "object",
                        value: convertObjectToString(args[i])
                    };
                } else {
                    parameterList[i] = {
                        type: "primitive",
                        value: args[i]
                    };
                }
            }

            return parameterList;
        }

        var proxyApply = function(target, that, args) {
            if(!_running) {
                return Reflect.apply(target, that, args);
            }

            var calleeData = {
                parent: parent,
                name: name,
                depth: ACTIVE_QUEUE.length + 1,
                target: target,
                caller: getCallerData(arguments.callee.caller),
                count: 1,
                time: Date.now()
            };

            calleeData.sequence = PROFILE_SEQUENCE[getFullName(calleeData)];
            ACTIVE_QUEUE.push(calleeData);

            var parameterList = getProxyParameters(args, calleeData);
            var realReturnValue = Reflect.apply(target, that, args);
            var returnValue = null;
            var endCalleeData = popCalleeData(target)[0];

            // TODO: 재귀호출시 처리 방법에 대해 고민해보자
            if(endCalleeData == undefined) {
                PROFILES[PROFILES.length - 1].callCount += 1;
                return realReturnValue;
            }

            var calleeName = getFullName(endCalleeData);
            var callerName = "global/0";
            var callerDepth = 0;

            // 호출자 풀네임 가공하기
            if(callerObj !== undefined) {
                callerName = callerObj.parent + "." + callerObj.name + "/" + callerObj.sequence;
                callerDepth = callerObj.depth;
            } else {
                if(endCalleeData.caller != null) {
                    var fullName = getFullName(endCalleeData.caller);

                    callerName = fullName + "/" + endCalleeData.caller.sequence;
                    callerDepth = endCalleeData.caller.depth;
                }
            }

            // 응답값이 기본형이 아닐 경우에 대한 처리
            if(typeof(realReturnValue) == "function") {
                returnValue = "function";
            } else if(typeof(realReturnValue) == "object") {
                returnValue = convertObjectToString(returnValue);
            } else {
                returnValue = realReturnValue;
            }

            PROFILES.push({
                startTime: endCalleeData.time,
                parentName: endCalleeData.parent,
                functionName: endCalleeData.name,
                calleeName: calleeName + "/" + PROFILE_SEQUENCE[calleeName],
                callerName: callerName,
                callerDepth: callerDepth,
                responseTime: Date.now() - endCalleeData.time,
                returnValue: returnValue,
                parameterList: parameterList,
                callCount: endCalleeData.count
            });


            PROFILE_SEQUENCE[calleeName] += 1;

            return realReturnValue;
        };

        return new Proxy(obj, {
            apply: proxyApply
        });
    }

    function getFullName(obj) {
        return obj.parent != null ? obj.parent + "." + obj.name : obj.name;
    }

    function getCallerData(caller) {
        for(var i = 0; i < ACTIVE_QUEUE.length; i++) {
            if(caller == ACTIVE_QUEUE[i].target) {
                return ACTIVE_QUEUE[i];
            }
        }

        return null;
    }

    function popCalleeData(callee) {
        var origin = [],
            result = [];
        for(var i = 0; i < ACTIVE_QUEUE.length; i++) {
            var active = ACTIVE_QUEUE[i];

            if(callee == active.target) {
                result.push(active);
            } else {
                origin.push(active);
            }
        }

        ACTIVE_QUEUE = origin;
        return result;
    }

    function convertObjectToString(obj) {
        var values = [];

        for(var key in obj) {
            if(typeof(obj[key]) == "object") {
                values.push(key + ":object");
            } else {
                if(typeof(obj[key]) == "function") {
                    values.push(key + ":function");
                } else {
                    values.push(key + ":" + obj[key]);
                }
            }
        }

        return "{" + values.join(",") + "}";
    }

    function initializeProxies(origin, depth) {
        var root = eval(origin);
        var reg1 = /^[0-9]*$/;
        var reg2 = /[0-9a-zA-Z_$]/;

        for(var name in root) {
            if(reg1.test(name) || !reg2.test(name) || name.indexOf(" ") != -1) continue;

            var path = origin + "." + name;

            if(typeof(root[name]) == "function") {
                if(!_options.exceptFunctions.includes(name)) {
                    root[name] = createProxy(origin, name, root[name]);
                }
            }

            if(typeof(root[name]) == "function" || typeof(root[name]) == "object") {
                // TODO: object[string] 형태로 설정된 객체는 제외함. 차후 개선할 필요가 있음
                if(name.indexOf(".") == -1 && depth < _options.maxDepth) {
                    if(!_options.exceptObjects.includes(name)) {
                        initializeProxies(path, depth + 1);
                    }
                }
            }
        }
    }

    return {
        setup: function (opts) {
            if (typeof(opts) != "object" || _initialize) return;

            if (typeof(opts.startPoint) == "string") {
                _options.startPoint = opts.startPoint;
            }

            if (typeof(opts.maxDepth) == "number") {
                _options.maxDepth = opts.maxDepth;
            }

            if (typeof(opts.exceptFunctions) == "object" && opts.exceptFunctions.length) {
                _options.exceptFunctions = _options.exceptFunctions.concat(opts.exceptFunctions);
            }

            if (typeof(opts.exceptObjects) == "object" && opts.exceptObjects.length) {
                _options.exceptObjects = _options.exceptObjects.concat(opts.exceptObjects);
            }
        },
        start: function () {
            if (!_initialize) {
                initializeProxies(_options.startPoint, 0);
                _initialize = true;
                _running = true;
            }
        },
        end: function () {
            _running = false;
        },
        reset: function () {
            PROFILES.length = 0;
        },
        print: function() {
            if(typeof(console.table) == "function") {
                console.table(PROFILES);
            }
        },
        show: function(url) {
            _running = false;
            window.open(url, "", "width=1024, height=768");
        },
        data: PROFILES
    }
}));