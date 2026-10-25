export namespace api {
	
	export class BrowserExtensionResult {
	    path: string;
	    version: string;
	    browser: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new BrowserExtensionResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.version = source["version"];
	        this.browser = source["browser"];
	        this.error = source["error"];
	    }
	}
	export class CollectionTextFile {
	    path: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new CollectionTextFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	    }
	}
	export class CollectionTextFilesResult {
	    root: string;
	    name: string;
	    files: CollectionTextFile[];
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new CollectionTextFilesResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.name = source["name"];
	        this.files = this.convertValues(source["files"], CollectionTextFile);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DefaultWorkspaceLocationResult {
	    path: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new DefaultWorkspaceLocationResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.error = source["error"];
	    }
	}
	export class DownloadResult {
	    response: model.HttpResponse;
	    savedPath: string;
	
	    static createFrom(source: any = {}) {
	        return new DownloadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.response = this.convertValues(source["response"], model.HttpResponse);
	        this.savedPath = source["savedPath"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitAuthConfigResult {
	    method: string;
	    sshKeyPath: string;
	
	    static createFrom(source: any = {}) {
	        return new GitAuthConfigResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.method = source["method"];
	        this.sshKeyPath = source["sshKeyPath"];
	    }
	}
	export class GitBranchEntry {
	    name: string;
	    fullName: string;
	    remote: string;
	    current: boolean;
	    upstream: string;
	
	    static createFrom(source: any = {}) {
	        return new GitBranchEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.fullName = source["fullName"];
	        this.remote = source["remote"];
	        this.current = source["current"];
	        this.upstream = source["upstream"];
	    }
	}
	export class GitStashEntry {
	    ref: string;
	    index: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new GitStashEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ref = source["ref"];
	        this.index = source["index"];
	        this.message = source["message"];
	    }
	}
	export class GitFileStatus {
	    path: string;
	    index: string;
	    worktree: string;
	    status: string;
	    managed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitFileStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.index = source["index"];
	        this.worktree = source["worktree"];
	        this.status = source["status"];
	        this.managed = source["managed"];
	    }
	}
	export class GitWorkspaceStatus {
	    isRepo: boolean;
	    workspaceRoot: string;
	    root: string;
	    missingRoot: boolean;
	    branch: string;
	    head: string;
	    upstream: string;
	    upstreamGone: boolean;
	    ahead: number;
	    behind: number;
	    pushCommitCount: number;
	    pushRemote: string;
	    operation: string;
	    clean: boolean;
	    files: GitFileStatus[];
	    remotes: string[];
	    stashes: GitStashEntry[];
	    error: string;
	    gitMissing: boolean;
	    authRequired: boolean;
	    authScheme: string;
	    authHost: string;
	    tokenRejected: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitWorkspaceStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.isRepo = source["isRepo"];
	        this.workspaceRoot = source["workspaceRoot"];
	        this.root = source["root"];
	        this.missingRoot = source["missingRoot"];
	        this.branch = source["branch"];
	        this.head = source["head"];
	        this.upstream = source["upstream"];
	        this.upstreamGone = source["upstreamGone"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.pushCommitCount = source["pushCommitCount"];
	        this.pushRemote = source["pushRemote"];
	        this.operation = source["operation"];
	        this.clean = source["clean"];
	        this.files = this.convertValues(source["files"], GitFileStatus);
	        this.remotes = source["remotes"];
	        this.stashes = this.convertValues(source["stashes"], GitStashEntry);
	        this.error = source["error"];
	        this.gitMissing = source["gitMissing"];
	        this.authRequired = source["authRequired"];
	        this.authScheme = source["authScheme"];
	        this.authHost = source["authHost"];
	        this.tokenRejected = source["tokenRejected"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitBranchListResult {
	    ok: boolean;
	    git: GitWorkspaceStatus;
	    current: string;
	    localBranches: GitBranchEntry[];
	    remoteBranches: GitBranchEntry[];
	    error: string;
	    output: string;
	
	    static createFrom(source: any = {}) {
	        return new GitBranchListResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.git = this.convertValues(source["git"], GitWorkspaceStatus);
	        this.current = source["current"];
	        this.localBranches = this.convertValues(source["localBranches"], GitBranchEntry);
	        this.remoteBranches = this.convertValues(source["remoteBranches"], GitBranchEntry);
	        this.error = source["error"];
	        this.output = source["output"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitCommitEntry {
	    hash: string;
	    shortHash: string;
	    author: string;
	    date: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new GitCommitEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.shortHash = source["shortHash"];
	        this.author = source["author"];
	        this.date = source["date"];
	        this.message = source["message"];
	    }
	}
	export class GitConflictFileResult {
	    ok: boolean;
	    git: GitWorkspaceStatus;
	    path: string;
	    content: string;
	    oursContent: string;
	    theirsContent: string;
	    oursAvailable: boolean;
	    theirsAvailable: boolean;
	    binary: boolean;
	    truncated: boolean;
	    oursTruncated: boolean;
	    theirsTruncated: boolean;
	    error: string;
	    output: string;
	
	    static createFrom(source: any = {}) {
	        return new GitConflictFileResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.git = this.convertValues(source["git"], GitWorkspaceStatus);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.oursContent = source["oursContent"];
	        this.theirsContent = source["theirsContent"];
	        this.oursAvailable = source["oursAvailable"];
	        this.theirsAvailable = source["theirsAvailable"];
	        this.binary = source["binary"];
	        this.truncated = source["truncated"];
	        this.oursTruncated = source["oursTruncated"];
	        this.theirsTruncated = source["theirsTruncated"];
	        this.error = source["error"];
	        this.output = source["output"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitDiffResult {
	    path: string;
	    diff: string;
	    stagedDiff: string;
	    unstagedDiff: string;
	    binary: boolean;
	    truncated: boolean;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new GitDiffResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.diff = source["diff"];
	        this.stagedDiff = source["stagedDiff"];
	        this.unstagedDiff = source["unstagedDiff"];
	        this.binary = source["binary"];
	        this.truncated = source["truncated"];
	        this.error = source["error"];
	    }
	}
	
	export class GitLogResult {
	    ok: boolean;
	    git: GitWorkspaceStatus;
	    commits: GitCommitEntry[];
	    limit: number;
	    offset: number;
	    hasMore: boolean;
	    error: string;
	    output: string;
	
	    static createFrom(source: any = {}) {
	        return new GitLogResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.git = this.convertValues(source["git"], GitWorkspaceStatus);
	        this.commits = this.convertValues(source["commits"], GitCommitEntry);
	        this.limit = source["limit"];
	        this.offset = source["offset"];
	        this.hasMore = source["hasMore"];
	        this.error = source["error"];
	        this.output = source["output"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GitPullSummary {
	    changed: number;
	    added: number;
	    updated: number;
	    deleted: number;
	    renamed: number;
	
	    static createFrom(source: any = {}) {
	        return new GitPullSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.changed = source["changed"];
	        this.added = source["added"];
	        this.updated = source["updated"];
	        this.deleted = source["deleted"];
	        this.renamed = source["renamed"];
	    }
	}
	export class GitOperationResult {
	    ok: boolean;
	    git: GitWorkspaceStatus;
	    error: string;
	    output: string;
	    files: string[];
	    pullSummary: GitPullSummary;
	    commitCount: number;
	
	    static createFrom(source: any = {}) {
	        return new GitOperationResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.git = this.convertValues(source["git"], GitWorkspaceStatus);
	        this.error = source["error"];
	        this.output = source["output"];
	        this.files = source["files"];
	        this.pullSummary = this.convertValues(source["pullSummary"], GitPullSummary);
	        this.commitCount = source["commitCount"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class GitTokenInfoResult {
	    host: string;
	    hasToken: boolean;
	    username: string;
	
	    static createFrom(source: any = {}) {
	        return new GitTokenInfoResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.host = source["host"];
	        this.hasToken = source["hasToken"];
	        this.username = source["username"];
	    }
	}
	
	export class HistoryResponseResult {
	    stored: boolean;
	    truncated: boolean;
	    payload?: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new HistoryResponseResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.stored = source["stored"];
	        this.truncated = source["truncated"];
	        this.payload = source["payload"];
	        this.error = source["error"];
	    }
	}
	export class SaveRequestStoreResult {
	    ok: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new SaveRequestStoreResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.error = source["error"];
	    }
	}
	export class SaveResponseBodyResult {
	    savedPath: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new SaveResponseBodyResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.savedPath = source["savedPath"];
	        this.error = source["error"];
	    }
	}
	export class WorkspaceDiagnostic {
	    scope: string;
	    severity: string;
	    path: string;
	    message: string;
	    workspaceId?: string;
	    collectionId?: string;
	    requestId?: string;
	    line?: number;
	    column?: number;
	    blocking: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceDiagnostic(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.scope = source["scope"];
	        this.severity = source["severity"];
	        this.path = source["path"];
	        this.message = source["message"];
	        this.workspaceId = source["workspaceId"];
	        this.collectionId = source["collectionId"];
	        this.requestId = source["requestId"];
	        this.line = source["line"];
	        this.column = source["column"];
	        this.blocking = source["blocking"];
	    }
	}
	export class WorkspaceSecretRef {
	    key: string;
	    label: string;
	    scope: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceSecretRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.label = source["label"];
	        this.scope = source["scope"];
	    }
	}
	export class WorkspaceOpenResult {
	    ok: boolean;
	    root: string;
	    payload: string;
	    git: GitWorkspaceStatus;
	    missingSecrets: WorkspaceSecretRef[];
	    diagnostics: WorkspaceDiagnostic[];
	    error: string;
	    output: string;
	    pullSummary: GitPullSummary;
	    targetExists: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceOpenResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.root = source["root"];
	        this.payload = source["payload"];
	        this.git = this.convertValues(source["git"], GitWorkspaceStatus);
	        this.missingSecrets = this.convertValues(source["missingSecrets"], WorkspaceSecretRef);
	        this.diagnostics = this.convertValues(source["diagnostics"], WorkspaceDiagnostic);
	        this.error = source["error"];
	        this.output = source["output"];
	        this.pullSummary = this.convertValues(source["pullSummary"], GitPullSummary);
	        this.targetExists = source["targetExists"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class WorkspaceYAMLCheckResult {
	    ok: boolean;
	    line: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceYAMLCheckResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.line = source["line"];
	        this.message = source["message"];
	    }
	}
	export class WorkspaceYAMLFileResult {
	    ok: boolean;
	    path: string;
	    content: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceYAMLFileResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.path = source["path"];
	        this.content = source["content"];
	        this.error = source["error"];
	    }
	}

}

export namespace model {
	
	export class AiBlock {
	    type: string;
	    text?: string;
	    id?: string;
	    name?: string;
	    input?: string;
	    server?: string;
	    isError?: boolean;
	    signature?: string;
	    data?: string;
	
	    static createFrom(source: any = {}) {
	        return new AiBlock(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.text = source["text"];
	        this.id = source["id"];
	        this.name = source["name"];
	        this.input = source["input"];
	        this.server = source["server"];
	        this.isError = source["isError"];
	        this.signature = source["signature"];
	        this.data = source["data"];
	    }
	}
	export class AiMessage {
	    role: string;
	    blocks: AiBlock[];
	
	    static createFrom(source: any = {}) {
	        return new AiMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.blocks = this.convertValues(source["blocks"], AiBlock);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiToolServer {
	    name: string;
	    request: HttpRequest;
	
	    static createFrom(source: any = {}) {
	        return new AiToolServer(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.request = this.convertValues(source["request"], HttpRequest);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiSettings {
	    temperature?: number;
	    topP?: number;
	    maxTokens?: number;
	    stream: boolean;
	    thinking?: string;
	    idleTimeoutSec?: number;
	
	    static createFrom(source: any = {}) {
	        return new AiSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.temperature = source["temperature"];
	        this.topP = source["topP"];
	        this.maxTokens = source["maxTokens"];
	        this.stream = source["stream"];
	        this.thinking = source["thinking"];
	        this.idleTimeoutSec = source["idleTimeoutSec"];
	    }
	}
	export class GraphQLPayload {
	    query: string;
	    variables: string;
	    operationName: string;
	
	    static createFrom(source: any = {}) {
	        return new GraphQLPayload(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	        this.variables = source["variables"];
	        this.operationName = source["operationName"];
	    }
	}
	export class AuthConfig {
	    type: string;
	    token: string;
	    username: string;
	    password: string;
	    keyName: string;
	    keyValue: string;
	    keyIn: string;
	    oauth2GrantType: string;
	    oauth2TokenURL: string;
	    oauth2AuthURL: string;
	    oauth2DeviceAuthURL: string;
	    oauth2RedirectURL: string;
	    oauth2ClientID: string;
	    oauth2Secret: string;
	    oauth2Scope: string;
	    oauth2Audience: string;
	    oauth2UsePKCE: boolean;
	    oauth2RefreshToken: string;
	    oauth2InsecureSkipVerify: boolean;
	    oauth2Username: string;
	    oauth2Password: string;
	    oauth2ClientAuth: string;
	    oauth2AssertionAlgorithm: string;
	    oauth2AssertionPrivateKey: string;
	    oauth2AssertionKeyID: string;
	    oauth2AssertionAudience: string;
	    awsAccessKey: string;
	    awsSecretKey: string;
	    awsSessionToken: string;
	    awsRegion: string;
	    awsService: string;
	    oauth1ConsumerKey: string;
	    oauth1ConsumerSecret: string;
	    oauth1Token: string;
	    oauth1TokenSecret: string;
	    oauth1SignatureMethod: string;
	    oauth1PrivateKey: string;
	    oauth1Realm: string;
	    oauth1Callback: string;
	    oauth1Verifier: string;
	    oauth1Timestamp: string;
	    oauth1Nonce: string;
	    oauth1Version: string;
	    oauth1AddTo: string;
	    oauth1IncludeBodyHash: boolean;
	    oauth1AddEmptyParams: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AuthConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.token = source["token"];
	        this.username = source["username"];
	        this.password = source["password"];
	        this.keyName = source["keyName"];
	        this.keyValue = source["keyValue"];
	        this.keyIn = source["keyIn"];
	        this.oauth2GrantType = source["oauth2GrantType"];
	        this.oauth2TokenURL = source["oauth2TokenURL"];
	        this.oauth2AuthURL = source["oauth2AuthURL"];
	        this.oauth2DeviceAuthURL = source["oauth2DeviceAuthURL"];
	        this.oauth2RedirectURL = source["oauth2RedirectURL"];
	        this.oauth2ClientID = source["oauth2ClientID"];
	        this.oauth2Secret = source["oauth2Secret"];
	        this.oauth2Scope = source["oauth2Scope"];
	        this.oauth2Audience = source["oauth2Audience"];
	        this.oauth2UsePKCE = source["oauth2UsePKCE"];
	        this.oauth2RefreshToken = source["oauth2RefreshToken"];
	        this.oauth2InsecureSkipVerify = source["oauth2InsecureSkipVerify"];
	        this.oauth2Username = source["oauth2Username"];
	        this.oauth2Password = source["oauth2Password"];
	        this.oauth2ClientAuth = source["oauth2ClientAuth"];
	        this.oauth2AssertionAlgorithm = source["oauth2AssertionAlgorithm"];
	        this.oauth2AssertionPrivateKey = source["oauth2AssertionPrivateKey"];
	        this.oauth2AssertionKeyID = source["oauth2AssertionKeyID"];
	        this.oauth2AssertionAudience = source["oauth2AssertionAudience"];
	        this.awsAccessKey = source["awsAccessKey"];
	        this.awsSecretKey = source["awsSecretKey"];
	        this.awsSessionToken = source["awsSessionToken"];
	        this.awsRegion = source["awsRegion"];
	        this.awsService = source["awsService"];
	        this.oauth1ConsumerKey = source["oauth1ConsumerKey"];
	        this.oauth1ConsumerSecret = source["oauth1ConsumerSecret"];
	        this.oauth1Token = source["oauth1Token"];
	        this.oauth1TokenSecret = source["oauth1TokenSecret"];
	        this.oauth1SignatureMethod = source["oauth1SignatureMethod"];
	        this.oauth1PrivateKey = source["oauth1PrivateKey"];
	        this.oauth1Realm = source["oauth1Realm"];
	        this.oauth1Callback = source["oauth1Callback"];
	        this.oauth1Verifier = source["oauth1Verifier"];
	        this.oauth1Timestamp = source["oauth1Timestamp"];
	        this.oauth1Nonce = source["oauth1Nonce"];
	        this.oauth1Version = source["oauth1Version"];
	        this.oauth1AddTo = source["oauth1AddTo"];
	        this.oauth1IncludeBodyHash = source["oauth1IncludeBodyHash"];
	        this.oauth1AddEmptyParams = source["oauth1AddEmptyParams"];
	    }
	}
	export class KeyValue {
	    key: string;
	    value: string;
	    enabled: boolean;
	    isFile: boolean;
	    fileName: string;
	    contentType: string;
	
	    static createFrom(source: any = {}) {
	        return new KeyValue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	        this.enabled = source["enabled"];
	        this.isFile = source["isFile"];
	        this.fileName = source["fileName"];
	        this.contentType = source["contentType"];
	    }
	}
	export class HttpRequest {
	    requestId: string;
	    workspaceId: string;
	    method: string;
	    url: string;
	    params: KeyValue[];
	    pathParams: KeyValue[];
	    headers: KeyValue[];
	    auth: AuthConfig;
	    bodyType: string;
	    body: string;
	    bodyFilePath: string;
	    formData: KeyValue[];
	    preRequestScript: string;
	    testScript: string;
	    scriptEngine: string;
	    followRedirects: boolean;
	    timeoutMs: number;
	    name: string;
	    scriptTimeoutMs: number;
	    allowSendRequest: boolean;
	    iteration?: number;
	    iterationCount?: number;
	    httpVersion: string;
	    enableSSLVerification: boolean;
	    followOriginalMethod: boolean;
	    followAuthorizationHeader: boolean;
	    removeRefererHeader: boolean;
	    encodeUrlAutomatically: boolean;
	    disableCookieJar: boolean;
	    maxRedirects: number;
	    secretEnvironmentKeys: string[];
	    secretEnvironmentValues: string[];
	    collectionVariables: Record<string, string>;
	    iterationData?: Record<string, string>;
	    resolveTemplates?: boolean;
	    templateValues?: Record<string, string>;
	    graphql?: GraphQLPayload;
	    proxyUrl: string;
	    proxyMode: string;
	    proxyBypass: string;
	    clientCertPath: string;
	    clientKeyPath: string;
	    clientKeyPassword: string;
	    browserEmulation: boolean;
	    browserOrigin: string;
	    browserWithCredentials: boolean;
	    browserEnforceCORS: boolean;
	    browserEnforceCSP: boolean;
	    browserCSP: string;
	    wsHandshakeTimeoutMs: number;
	    wsReconnectAttempts: number;
	    wsReconnectIntervalMs: number;
	    wsMaxMessageSizeMb: number;
	    wsKeepAliveIntervalMs: number;
	    sioClientVersion: string;
	    sioPath: string;
	    sioNamespace: string;
	    sioListenEvents: string[];
	    sseDisableReconnect: boolean;
	    sseReconnectIntervalMs: number;
	    mcpProtocolVersion: string;
	    mcpMethod: string;
	    mcpName: string;
	    mcpArguments: string;
	    mcpCursor: string;
	    mcpInputResponses: string;
	    mcpRequestState: string;
	    mcpInputSchema: string;
	    mcpOutputSchema: string;
	
	    static createFrom(source: any = {}) {
	        return new HttpRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestId = source["requestId"];
	        this.workspaceId = source["workspaceId"];
	        this.method = source["method"];
	        this.url = source["url"];
	        this.params = this.convertValues(source["params"], KeyValue);
	        this.pathParams = this.convertValues(source["pathParams"], KeyValue);
	        this.headers = this.convertValues(source["headers"], KeyValue);
	        this.auth = this.convertValues(source["auth"], AuthConfig);
	        this.bodyType = source["bodyType"];
	        this.body = source["body"];
	        this.bodyFilePath = source["bodyFilePath"];
	        this.formData = this.convertValues(source["formData"], KeyValue);
	        this.preRequestScript = source["preRequestScript"];
	        this.testScript = source["testScript"];
	        this.scriptEngine = source["scriptEngine"];
	        this.followRedirects = source["followRedirects"];
	        this.timeoutMs = source["timeoutMs"];
	        this.name = source["name"];
	        this.scriptTimeoutMs = source["scriptTimeoutMs"];
	        this.allowSendRequest = source["allowSendRequest"];
	        this.iteration = source["iteration"];
	        this.iterationCount = source["iterationCount"];
	        this.httpVersion = source["httpVersion"];
	        this.enableSSLVerification = source["enableSSLVerification"];
	        this.followOriginalMethod = source["followOriginalMethod"];
	        this.followAuthorizationHeader = source["followAuthorizationHeader"];
	        this.removeRefererHeader = source["removeRefererHeader"];
	        this.encodeUrlAutomatically = source["encodeUrlAutomatically"];
	        this.disableCookieJar = source["disableCookieJar"];
	        this.maxRedirects = source["maxRedirects"];
	        this.secretEnvironmentKeys = source["secretEnvironmentKeys"];
	        this.secretEnvironmentValues = source["secretEnvironmentValues"];
	        this.collectionVariables = source["collectionVariables"];
	        this.iterationData = source["iterationData"];
	        this.resolveTemplates = source["resolveTemplates"];
	        this.templateValues = source["templateValues"];
	        this.graphql = this.convertValues(source["graphql"], GraphQLPayload);
	        this.proxyUrl = source["proxyUrl"];
	        this.proxyMode = source["proxyMode"];
	        this.proxyBypass = source["proxyBypass"];
	        this.clientCertPath = source["clientCertPath"];
	        this.clientKeyPath = source["clientKeyPath"];
	        this.clientKeyPassword = source["clientKeyPassword"];
	        this.browserEmulation = source["browserEmulation"];
	        this.browserOrigin = source["browserOrigin"];
	        this.browserWithCredentials = source["browserWithCredentials"];
	        this.browserEnforceCORS = source["browserEnforceCORS"];
	        this.browserEnforceCSP = source["browserEnforceCSP"];
	        this.browserCSP = source["browserCSP"];
	        this.wsHandshakeTimeoutMs = source["wsHandshakeTimeoutMs"];
	        this.wsReconnectAttempts = source["wsReconnectAttempts"];
	        this.wsReconnectIntervalMs = source["wsReconnectIntervalMs"];
	        this.wsMaxMessageSizeMb = source["wsMaxMessageSizeMb"];
	        this.wsKeepAliveIntervalMs = source["wsKeepAliveIntervalMs"];
	        this.sioClientVersion = source["sioClientVersion"];
	        this.sioPath = source["sioPath"];
	        this.sioNamespace = source["sioNamespace"];
	        this.sioListenEvents = source["sioListenEvents"];
	        this.sseDisableReconnect = source["sseDisableReconnect"];
	        this.sseReconnectIntervalMs = source["sseReconnectIntervalMs"];
	        this.mcpProtocolVersion = source["mcpProtocolVersion"];
	        this.mcpMethod = source["mcpMethod"];
	        this.mcpName = source["mcpName"];
	        this.mcpArguments = source["mcpArguments"];
	        this.mcpCursor = source["mcpCursor"];
	        this.mcpInputResponses = source["mcpInputResponses"];
	        this.mcpRequestState = source["mcpRequestState"];
	        this.mcpInputSchema = source["mcpInputSchema"];
	        this.mcpOutputSchema = source["mcpOutputSchema"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiRequest {
	    http: HttpRequest;
	    provider: string;
	    model: string;
	    system: string;
	    messages: AiMessage[];
	    settings: AiSettings;
	    toolServers: AiToolServer[];
	    maxSteps: number;
	    turnId?: string;
	
	    static createFrom(source: any = {}) {
	        return new AiRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.http = this.convertValues(source["http"], HttpRequest);
	        this.provider = source["provider"];
	        this.model = source["model"];
	        this.system = source["system"];
	        this.messages = this.convertValues(source["messages"], AiMessage);
	        this.settings = this.convertValues(source["settings"], AiSettings);
	        this.toolServers = this.convertValues(source["toolServers"], AiToolServer);
	        this.maxSteps = source["maxSteps"];
	        this.turnId = source["turnId"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiToolInfo {
	    name: string;
	    originalName: string;
	    server: string;
	    description?: string;
	
	    static createFrom(source: any = {}) {
	        return new AiToolInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.originalName = source["originalName"];
	        this.server = source["server"];
	        this.description = source["description"];
	    }
	}
	export class TimelineEvent {
	    label: string;
	    atMs: number;
	    detail?: string;
	
	    static createFrom(source: any = {}) {
	        return new TimelineEvent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.label = source["label"];
	        this.atMs = source["atMs"];
	        this.detail = source["detail"];
	    }
	}
	export class ConnectionInfo {
	    reused: boolean;
	    wasIdle: boolean;
	    localAddr?: string;
	    remoteAddr?: string;
	    protocol?: string;
	    tlsVersion?: string;
	    tlsCipher?: string;
	    alpn?: string;
	    serverName?: string;
	    addresses?: string[];
	
	    static createFrom(source: any = {}) {
	        return new ConnectionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reused = source["reused"];
	        this.wasIdle = source["wasIdle"];
	        this.localAddr = source["localAddr"];
	        this.remoteAddr = source["remoteAddr"];
	        this.protocol = source["protocol"];
	        this.tlsVersion = source["tlsVersion"];
	        this.tlsCipher = source["tlsCipher"];
	        this.alpn = source["alpn"];
	        this.serverName = source["serverName"];
	        this.addresses = source["addresses"];
	    }
	}
	export class SentRequest {
	    method: string;
	    url: string;
	    proto: string;
	    headers: KeyValue[];
	
	    static createFrom(source: any = {}) {
	        return new SentRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.method = source["method"];
	        this.url = source["url"];
	        this.proto = source["proto"];
	        this.headers = this.convertValues(source["headers"], KeyValue);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TestResult {
	    name: string;
	    passed: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new TestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.passed = source["passed"];
	        this.error = source["error"];
	    }
	}
	export class ScriptResult {
	    tests: TestResult[];
	    logs?: string[];
	    error?: string;
	    skippedRequest?: boolean;
	    collectionVariables?: Record<string, string>;
	    collectionVariablesRemoved?: string[];
	
	    static createFrom(source: any = {}) {
	        return new ScriptResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tests = this.convertValues(source["tests"], TestResult);
	        this.logs = source["logs"];
	        this.error = source["error"];
	        this.skippedRequest = source["skippedRequest"];
	        this.collectionVariables = source["collectionVariables"];
	        this.collectionVariablesRemoved = source["collectionVariablesRemoved"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ResponseTime {
	    total: number;
	    prepare: number;
	    socketInitialization: number;
	    dnsLookup: number;
	    tcpHandshake: number;
	    tlsHandshake: number;
	    waitingTTFB: number;
	    download: number;
	    process: number;
	
	    static createFrom(source: any = {}) {
	        return new ResponseTime(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.prepare = source["prepare"];
	        this.socketInitialization = source["socketInitialization"];
	        this.dnsLookup = source["dnsLookup"];
	        this.tcpHandshake = source["tcpHandshake"];
	        this.tlsHandshake = source["tlsHandshake"];
	        this.waitingTTFB = source["waitingTTFB"];
	        this.download = source["download"];
	        this.process = source["process"];
	    }
	}
	export class HttpResponse {
	    statusCode: number;
	    status: string;
	    headers: KeyValue[];
	    body: string;
	    duration: number;
	    timings: ResponseTime;
	    size: number;
	    error?: string;
	    preRequestResult: ScriptResult;
	    testResult: ScriptResult;
	    sentRequests?: SentRequest[];
	    connection: ConnectionInfo;
	    timeline?: TimelineEvent[];
	    skipped?: boolean;
	    skipReason?: string;
	    warnings?: string[];
	    browserHiddenHeaders?: string[];
	    previewImageBase64?: string;
	    previewMediaType?: string;
	    bodyIsBinary?: boolean;
	    bodySniffedType?: string;
	    bodyOmitted?: boolean;
	    collectionVariableUpdates?: Record<string, string>;
	    collectionVariablesRemoved?: string[];
	    environmentUpdates?: Record<string, string>;
	    environmentRemoved?: string[];
	    llm?: string;
	
	    static createFrom(source: any = {}) {
	        return new HttpResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.statusCode = source["statusCode"];
	        this.status = source["status"];
	        this.headers = this.convertValues(source["headers"], KeyValue);
	        this.body = source["body"];
	        this.duration = source["duration"];
	        this.timings = this.convertValues(source["timings"], ResponseTime);
	        this.size = source["size"];
	        this.error = source["error"];
	        this.preRequestResult = this.convertValues(source["preRequestResult"], ScriptResult);
	        this.testResult = this.convertValues(source["testResult"], ScriptResult);
	        this.sentRequests = this.convertValues(source["sentRequests"], SentRequest);
	        this.connection = this.convertValues(source["connection"], ConnectionInfo);
	        this.timeline = this.convertValues(source["timeline"], TimelineEvent);
	        this.skipped = source["skipped"];
	        this.skipReason = source["skipReason"];
	        this.warnings = source["warnings"];
	        this.browserHiddenHeaders = source["browserHiddenHeaders"];
	        this.previewImageBase64 = source["previewImageBase64"];
	        this.previewMediaType = source["previewMediaType"];
	        this.bodyIsBinary = source["bodyIsBinary"];
	        this.bodySniffedType = source["bodySniffedType"];
	        this.bodyOmitted = source["bodyOmitted"];
	        this.collectionVariableUpdates = source["collectionVariableUpdates"];
	        this.collectionVariablesRemoved = source["collectionVariablesRemoved"];
	        this.environmentUpdates = source["environmentUpdates"];
	        this.environmentRemoved = source["environmentRemoved"];
	        this.llm = source["llm"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiUsage {
	    input: number;
	    output: number;
	    cacheRead: number;
	    cacheWrite: number;
	    reasoning: number;
	
	    static createFrom(source: any = {}) {
	        return new AiUsage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.input = source["input"];
	        this.output = source["output"];
	        this.cacheRead = source["cacheRead"];
	        this.cacheWrite = source["cacheWrite"];
	        this.reasoning = source["reasoning"];
	    }
	}
	export class AiStep {
	    index: number;
	    method: string;
	    url: string;
	    requestBody: string;
	    blocks: AiBlock[];
	    toolResults: AiBlock[];
	    stopReason: string;
	    rawStopReason: string;
	    model: string;
	    usage: AiUsage;
	    hasUsage: boolean;
	    firstTokenMs: number;
	    durationMs: number;
	    error?: string;
	    http: HttpResponse;
	
	    static createFrom(source: any = {}) {
	        return new AiStep(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.method = source["method"];
	        this.url = source["url"];
	        this.requestBody = source["requestBody"];
	        this.blocks = this.convertValues(source["blocks"], AiBlock);
	        this.toolResults = this.convertValues(source["toolResults"], AiBlock);
	        this.stopReason = source["stopReason"];
	        this.rawStopReason = source["rawStopReason"];
	        this.model = source["model"];
	        this.usage = this.convertValues(source["usage"], AiUsage);
	        this.hasUsage = source["hasUsage"];
	        this.firstTokenMs = source["firstTokenMs"];
	        this.durationMs = source["durationMs"];
	        this.error = source["error"];
	        this.http = this.convertValues(source["http"], HttpResponse);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiResponse {
	    steps: AiStep[];
	    messages: AiMessage[];
	    text: string;
	    stopReason: string;
	    usage: AiUsage;
	    hasUsage: boolean;
	    firstTokenMs: number;
	    durationMs: number;
	    tools: AiToolInfo[];
	    warnings: string[];
	    error?: string;
	    http: HttpResponse;
	
	    static createFrom(source: any = {}) {
	        return new AiResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.steps = this.convertValues(source["steps"], AiStep);
	        this.messages = this.convertValues(source["messages"], AiMessage);
	        this.text = source["text"];
	        this.stopReason = source["stopReason"];
	        this.usage = this.convertValues(source["usage"], AiUsage);
	        this.hasUsage = source["hasUsage"];
	        this.firstTokenMs = source["firstTokenMs"];
	        this.durationMs = source["durationMs"];
	        this.tools = this.convertValues(source["tools"], AiToolInfo);
	        this.warnings = source["warnings"];
	        this.error = source["error"];
	        this.http = this.convertValues(source["http"], HttpResponse);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	
	
	export class AppInfo {
	    name: string;
	    version: string;
	    runtime: string;
	    goVersion: string;
	    packaged: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AppInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.version = source["version"];
	        this.runtime = source["runtime"];
	        this.goVersion = source["goVersion"];
	        this.packaged = source["packaged"];
	    }
	}
	
	
	export class Cookie {
	    name: string;
	    value: string;
	    domain: string;
	    path: string;
	    expiresAt: number;
	    session: boolean;
	    secure: boolean;
	    httpOnly: boolean;
	    sameSite: string;
	    hostOnly: boolean;
	    createdAt: number;
	    updatedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new Cookie(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.value = source["value"];
	        this.domain = source["domain"];
	        this.path = source["path"];
	        this.expiresAt = source["expiresAt"];
	        this.session = source["session"];
	        this.secure = source["secure"];
	        this.httpOnly = source["httpOnly"];
	        this.sameSite = source["sameSite"];
	        this.hostOnly = source["hostOnly"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	    }
	}
	export class CookieJarResult {
	    cookies: Cookie[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new CookieJarResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cookies = this.convertValues(source["cookies"], Cookie);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CookieSyncConfig {
	    enabled: boolean;
	    port: number;
	    domains: string[];
	
	    static createFrom(source: any = {}) {
	        return new CookieSyncConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.port = source["port"];
	        this.domains = source["domains"];
	    }
	}
	export class CookieSyncLog {
	    id: string;
	    timestamp: number;
	    browser: string;
	    domain: string;
	    accepted: number;
	    skipped: number;
	    removed: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new CookieSyncLog(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.timestamp = source["timestamp"];
	        this.browser = source["browser"];
	        this.domain = source["domain"];
	        this.accepted = source["accepted"];
	        this.skipped = source["skipped"];
	        this.removed = source["removed"];
	        this.message = source["message"];
	    }
	}
	export class CookieSyncPairRequest {
	    id: string;
	    browser: string;
	    extensionId: string;
	    code: string;
	    requestedAt: number;
	    expiresAt: number;
	
	    static createFrom(source: any = {}) {
	        return new CookieSyncPairRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.browser = source["browser"];
	        this.extensionId = source["extensionId"];
	        this.code = source["code"];
	        this.requestedAt = source["requestedAt"];
	        this.expiresAt = source["expiresAt"];
	    }
	}
	export class CookieSyncStatus {
	    enabled: boolean;
	    running: boolean;
	    port: number;
	    url: string;
	    pairingCode: string;
	    domains: string[];
	    paired: boolean;
	    connected: boolean;
	    browser: string;
	    extensionVersion?: string;
	    unreadable: string[];
	    lastContactAt: number;
	    lastSyncAt: number;
	    lastSyncCount: number;
	    syncedTotal: number;
	    pending: CookieSyncPairRequest;
	    log: CookieSyncLog[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new CookieSyncStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.running = source["running"];
	        this.port = source["port"];
	        this.url = source["url"];
	        this.pairingCode = source["pairingCode"];
	        this.domains = source["domains"];
	        this.paired = source["paired"];
	        this.connected = source["connected"];
	        this.browser = source["browser"];
	        this.extensionVersion = source["extensionVersion"];
	        this.unreadable = source["unreadable"];
	        this.lastContactAt = source["lastContactAt"];
	        this.lastSyncAt = source["lastSyncAt"];
	        this.lastSyncCount = source["lastSyncCount"];
	        this.syncedTotal = source["syncedTotal"];
	        this.pending = this.convertValues(source["pending"], CookieSyncPairRequest);
	        this.log = this.convertValues(source["log"], CookieSyncLog);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class GrpcMessage {
	    index: number;
	    direction?: string;
	    body: string;
	    size: number;
	    timestamp: number;
	
	    static createFrom(source: any = {}) {
	        return new GrpcMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.direction = source["direction"];
	        this.body = source["body"];
	        this.size = source["size"];
	        this.timestamp = source["timestamp"];
	    }
	}
	export class GrpcMethodInfo {
	    fullName: string;
	    service: string;
	    name: string;
	    requestType: string;
	    responseType: string;
	    exampleMessage: string;
	    clientStreaming: boolean;
	    serverStreaming: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GrpcMethodInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fullName = source["fullName"];
	        this.service = source["service"];
	        this.name = source["name"];
	        this.requestType = source["requestType"];
	        this.responseType = source["responseType"];
	        this.exampleMessage = source["exampleMessage"];
	        this.clientStreaming = source["clientStreaming"];
	        this.serverStreaming = source["serverStreaming"];
	    }
	}
	export class GrpcRequest {
	    requestId: string;
	    target: string;
	    fullMethod: string;
	    message: string;
	    metadata: KeyValue[];
	    auth: AuthConfig;
	    useReflection: boolean;
	    protoFilePath: string;
	    protoImportPaths: string[];
	    useTls: boolean;
	    enableSSLVerification: boolean;
	    serverName: string;
	    includeDefaultValues: boolean;
	    maxResponseMessageSizeMb: number;
	    timeoutMs: number;
	    preRequestScript: string;
	    testScript: string;
	    scriptEngine: string;
	    name: string;
	    scriptTimeoutMs: number;
	    allowSendRequest: boolean;
	    secretEnvironmentKeys: string[];
	    secretEnvironmentValues: string[];
	    collectionVariables: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new GrpcRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestId = source["requestId"];
	        this.target = source["target"];
	        this.fullMethod = source["fullMethod"];
	        this.message = source["message"];
	        this.metadata = this.convertValues(source["metadata"], KeyValue);
	        this.auth = this.convertValues(source["auth"], AuthConfig);
	        this.useReflection = source["useReflection"];
	        this.protoFilePath = source["protoFilePath"];
	        this.protoImportPaths = source["protoImportPaths"];
	        this.useTls = source["useTls"];
	        this.enableSSLVerification = source["enableSSLVerification"];
	        this.serverName = source["serverName"];
	        this.includeDefaultValues = source["includeDefaultValues"];
	        this.maxResponseMessageSizeMb = source["maxResponseMessageSizeMb"];
	        this.timeoutMs = source["timeoutMs"];
	        this.preRequestScript = source["preRequestScript"];
	        this.testScript = source["testScript"];
	        this.scriptEngine = source["scriptEngine"];
	        this.name = source["name"];
	        this.scriptTimeoutMs = source["scriptTimeoutMs"];
	        this.allowSendRequest = source["allowSendRequest"];
	        this.secretEnvironmentKeys = source["secretEnvironmentKeys"];
	        this.secretEnvironmentValues = source["secretEnvironmentValues"];
	        this.collectionVariables = source["collectionVariables"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GrpcResponse {
	    grpcCode: string;
	    grpcMessage: string;
	    status: string;
	    headers: KeyValue[];
	    trailers: KeyValue[];
	    messages: GrpcMessage[];
	    body: string;
	    duration: number;
	    size: number;
	    timestamp?: number;
	    error?: string;
	    method: GrpcMethodInfo;
	    preRequestResult: ScriptResult;
	    testResult: ScriptResult;
	    collectionVariableUpdates?: Record<string, string>;
	    collectionVariablesRemoved?: string[];
	
	    static createFrom(source: any = {}) {
	        return new GrpcResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.grpcCode = source["grpcCode"];
	        this.grpcMessage = source["grpcMessage"];
	        this.status = source["status"];
	        this.headers = this.convertValues(source["headers"], KeyValue);
	        this.trailers = this.convertValues(source["trailers"], KeyValue);
	        this.messages = this.convertValues(source["messages"], GrpcMessage);
	        this.body = source["body"];
	        this.duration = source["duration"];
	        this.size = source["size"];
	        this.timestamp = source["timestamp"];
	        this.error = source["error"];
	        this.method = this.convertValues(source["method"], GrpcMethodInfo);
	        this.preRequestResult = this.convertValues(source["preRequestResult"], ScriptResult);
	        this.testResult = this.convertValues(source["testResult"], ScriptResult);
	        this.collectionVariableUpdates = source["collectionVariableUpdates"];
	        this.collectionVariablesRemoved = source["collectionVariablesRemoved"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GrpcServiceDefinition {
	    source: string;
	    services: string[];
	    methods: GrpcMethodInfo[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new GrpcServiceDefinition(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.services = source["services"];
	        this.methods = this.convertValues(source["methods"], GrpcMethodInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class K6ExportStep {
	    stepId: string;
	    tag: string;
	
	    static createFrom(source: any = {}) {
	        return new K6ExportStep(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.stepId = source["stepId"];
	        this.tag = source["tag"];
	    }
	}
	export class K6ExportWarning {
	    level: string;
	    step?: number;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new K6ExportWarning(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.level = source["level"];
	        this.step = source["step"];
	        this.message = source["message"];
	    }
	}
	export class K6ExportResult {
	    script: string;
	    fileName: string;
	    warnings: K6ExportWarning[];
	    steps: K6ExportStep[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new K6ExportResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.script = source["script"];
	        this.fileName = source["fileName"];
	        this.warnings = this.convertValues(source["warnings"], K6ExportWarning);
	        this.steps = this.convertValues(source["steps"], K6ExportStep);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class K6Info {
	    found: boolean;
	    path: string;
	    version: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new K6Info(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.found = source["found"];
	        this.path = source["path"];
	        this.version = source["version"];
	        this.error = source["error"];
	    }
	}
	
	export class LoadCheck {
	    type: string;
	    path?: string;
	    value?: string;
	
	    static createFrom(source: any = {}) {
	        return new LoadCheck(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.path = source["path"];
	        this.value = source["value"];
	    }
	}
	export class LoadDataSource {
	    path: string;
	    mode: string;
	
	    static createFrom(source: any = {}) {
	        return new LoadDataSource(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.mode = source["mode"];
	    }
	}
	export class LoadStage {
	    durationMs: number;
	    target: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadStage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.durationMs = source["durationMs"];
	        this.target = source["target"];
	    }
	}
	export class LoadExecutor {
	    type: string;
	    vus?: number;
	    durationMs?: number;
	    stages?: LoadStage[];
	    rate?: number;
	    timeUnitMs?: number;
	    preAllocatedVUs?: number;
	    maxVUs?: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadExecutor(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.vus = source["vus"];
	        this.durationMs = source["durationMs"];
	        this.stages = this.convertValues(source["stages"], LoadStage);
	        this.rate = source["rate"];
	        this.timeUnitMs = source["timeUnitMs"];
	        this.preAllocatedVUs = source["preAllocatedVUs"];
	        this.maxVUs = source["maxVUs"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LoadExtract {
	    var: string;
	    from: string;
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new LoadExtract(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.var = source["var"];
	        this.from = source["from"];
	        this.path = source["path"];
	    }
	}
	export class LoadRunProgress {
	    elapsedMs: number;
	    vus: number;
	    maxVUs: number;
	    iterations: number;
	    interrupted: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadRunProgress(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.elapsedMs = source["elapsedMs"];
	        this.vus = source["vus"];
	        this.maxVUs = source["maxVUs"];
	        this.iterations = source["iterations"];
	        this.interrupted = source["interrupted"];
	    }
	}
	export class LoadRunStep {
	    stepId: string;
	    tag: string;
	    requests: number;
	    med: number;
	    p95: number;
	    p99: number;
	    failedRate: number;
	    checksRate: number;
	    checksPassed: number;
	    checksFailed: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadRunStep(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.stepId = source["stepId"];
	        this.tag = source["tag"];
	        this.requests = source["requests"];
	        this.med = source["med"];
	        this.p95 = source["p95"];
	        this.p99 = source["p99"];
	        this.failedRate = source["failedRate"];
	        this.checksRate = source["checksRate"];
	        this.checksPassed = source["checksPassed"];
	        this.checksFailed = source["checksFailed"];
	    }
	}
	export class LoadRunTotals {
	    requests: number;
	    rps: number;
	    avg: number;
	    med: number;
	    p95: number;
	    p99: number;
	    max: number;
	    failedRate: number;
	    failedCount: number;
	    checksPassed: number;
	    checksFailed: number;
	    iterations: number;
	    interrupted: number;
	    maxVUs: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadRunTotals(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requests = source["requests"];
	        this.rps = source["rps"];
	        this.avg = source["avg"];
	        this.med = source["med"];
	        this.p95 = source["p95"];
	        this.p99 = source["p99"];
	        this.max = source["max"];
	        this.failedRate = source["failedRate"];
	        this.failedCount = source["failedCount"];
	        this.checksPassed = source["checksPassed"];
	        this.checksFailed = source["checksFailed"];
	        this.iterations = source["iterations"];
	        this.interrupted = source["interrupted"];
	        this.maxVUs = source["maxVUs"];
	    }
	}
	export class LoadRunThreshold {
	    metric: string;
	    stepId?: string;
	    expression: string;
	    ok: boolean;
	    actual: number;
	    hasActual: boolean;
	
	    static createFrom(source: any = {}) {
	        return new LoadRunThreshold(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.metric = source["metric"];
	        this.stepId = source["stepId"];
	        this.expression = source["expression"];
	        this.ok = source["ok"];
	        this.actual = source["actual"];
	        this.hasActual = source["hasActual"];
	    }
	}
	export class LoadRunResult {
	    loadTestId: string;
	    collectionId: string;
	    loadTestName: string;
	    environment: string;
	    k6Version: string;
	    status: string;
	    exitCode: number;
	    startedAt: number;
	    finishedAt: number;
	    error?: string;
	    thresholds: LoadRunThreshold[];
	    totals: LoadRunTotals;
	    steps: LoadRunStep[];
	    hasReport: boolean;
	    hasSummary: boolean;
	
	    static createFrom(source: any = {}) {
	        return new LoadRunResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.loadTestId = source["loadTestId"];
	        this.collectionId = source["collectionId"];
	        this.loadTestName = source["loadTestName"];
	        this.environment = source["environment"];
	        this.k6Version = source["k6Version"];
	        this.status = source["status"];
	        this.exitCode = source["exitCode"];
	        this.startedAt = source["startedAt"];
	        this.finishedAt = source["finishedAt"];
	        this.error = source["error"];
	        this.thresholds = this.convertValues(source["thresholds"], LoadRunThreshold);
	        this.totals = this.convertValues(source["totals"], LoadRunTotals);
	        this.steps = this.convertValues(source["steps"], LoadRunStep);
	        this.hasReport = source["hasReport"];
	        this.hasSummary = source["hasSummary"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LoadRunState {
	    running: boolean;
	    stopping: boolean;
	    loadTestId: string;
	    collectionId: string;
	    startedAt: number;
	    plannedMs: number;
	    dashboardUrl: string;
	    k6Version: string;
	    progress: LoadRunProgress;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new LoadRunState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.stopping = source["stopping"];
	        this.loadTestId = source["loadTestId"];
	        this.collectionId = source["collectionId"];
	        this.startedAt = source["startedAt"];
	        this.plannedMs = source["plannedMs"];
	        this.dashboardUrl = source["dashboardUrl"];
	        this.k6Version = source["k6Version"];
	        this.progress = this.convertValues(source["progress"], LoadRunProgress);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	export class LoadStep {
	    id: string;
	    requestId: string;
	    name?: string;
	    once?: boolean;
	    extract?: LoadExtract[];
	    checks?: LoadCheck[];
	    thinkTimeMs?: number;
	    thinkJitterMs?: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadStep(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.requestId = source["requestId"];
	        this.name = source["name"];
	        this.once = source["once"];
	        this.extract = this.convertValues(source["extract"], LoadExtract);
	        this.checks = this.convertValues(source["checks"], LoadCheck);
	        this.thinkTimeMs = source["thinkTimeMs"];
	        this.thinkJitterMs = source["thinkJitterMs"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LoadScenario {
	    id: string;
	    name: string;
	    executor: LoadExecutor;
	    steps: LoadStep[];
	
	    static createFrom(source: any = {}) {
	        return new LoadScenario(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.executor = this.convertValues(source["executor"], LoadExecutor);
	        this.steps = this.convertValues(source["steps"], LoadStep);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LoadSettings {
	    environment?: string;
	    insecure?: boolean;
	    timeoutMs?: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.environment = source["environment"];
	        this.insecure = source["insecure"];
	        this.timeoutMs = source["timeoutMs"];
	    }
	}
	
	
	export class LoadThreshold {
	    metric: string;
	    stat: string;
	    op: string;
	    value: number;
	    step?: string;
	    abortOnFail?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new LoadThreshold(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.metric = source["metric"];
	        this.stat = source["stat"];
	        this.op = source["op"];
	        this.value = source["value"];
	        this.step = source["step"];
	        this.abortOnFail = source["abortOnFail"];
	    }
	}
	export class LoadTest {
	    id: string;
	    name: string;
	    filesystemName?: string;
	    scenarios: LoadScenario[];
	    thresholds?: LoadThreshold[];
	    data?: LoadDataSource;
	    settings: LoadSettings;
	
	    static createFrom(source: any = {}) {
	        return new LoadTest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.filesystemName = source["filesystemName"];
	        this.scenarios = this.convertValues(source["scenarios"], LoadScenario);
	        this.thresholds = this.convertValues(source["thresholds"], LoadThreshold);
	        this.data = this.convertValues(source["data"], LoadDataSource);
	        this.settings = this.convertValues(source["settings"], LoadSettings);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LoadTestRequest {
	    id: string;
	    requestType: string;
	
	    static createFrom(source: any = {}) {
	        return new LoadTestRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.requestType = source["requestType"];
	    }
	}
	
	export class McpContent {
	    type: string;
	    text?: string;
	    data?: string;
	    mimeType?: string;
	    uri?: string;
	    name?: string;
	    description?: string;
	
	    static createFrom(source: any = {}) {
	        return new McpContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.text = source["text"];
	        this.data = source["data"];
	        this.mimeType = source["mimeType"];
	        this.uri = source["uri"];
	        this.name = source["name"];
	        this.description = source["description"];
	    }
	}
	export class McpNotification {
	    method: string;
	    params?: string;
	
	    static createFrom(source: any = {}) {
	        return new McpNotification(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.method = source["method"];
	        this.params = source["params"];
	    }
	}
	export class McpPrompt {
	    name: string;
	    title?: string;
	    description?: string;
	    arguments?: string;
	
	    static createFrom(source: any = {}) {
	        return new McpPrompt(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.arguments = source["arguments"];
	    }
	}
	export class McpResource {
	    uri: string;
	    name?: string;
	    title?: string;
	    description?: string;
	    mimeType?: string;
	
	    static createFrom(source: any = {}) {
	        return new McpResource(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.uri = source["uri"];
	        this.name = source["name"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.mimeType = source["mimeType"];
	    }
	}
	export class McpTool {
	    name: string;
	    title?: string;
	    description?: string;
	    inputSchema?: string;
	    outputSchema?: string;
	    annotations?: string;
	    rejected?: string;
	
	    static createFrom(source: any = {}) {
	        return new McpTool(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.inputSchema = source["inputSchema"];
	        this.outputSchema = source["outputSchema"];
	        this.annotations = source["annotations"];
	        this.rejected = source["rejected"];
	    }
	}
	export class McpResponse {
	    http: HttpResponse;
	    serverName?: string;
	    serverVersion?: string;
	    instructions?: string;
	    protocolVersion?: string;
	    supportedVersions: string[];
	    capabilities: string[];
	    resultType?: string;
	    result?: string;
	    content: McpContent[];
	    structuredContent?: string;
	    isError?: boolean;
	    tools: McpTool[];
	    resources: McpResource[];
	    prompts: McpPrompt[];
	    nextCursor?: string;
	    ttlMs?: number;
	    cacheScope?: string;
	    inputRequests?: string;
	    requestState?: string;
	    notifications: McpNotification[];
	    rpcErrorCode?: number;
	    rpcErrorMessage?: string;
	    rpcErrorData?: string;
	    warnings: string[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new McpResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.http = this.convertValues(source["http"], HttpResponse);
	        this.serverName = source["serverName"];
	        this.serverVersion = source["serverVersion"];
	        this.instructions = source["instructions"];
	        this.protocolVersion = source["protocolVersion"];
	        this.supportedVersions = source["supportedVersions"];
	        this.capabilities = source["capabilities"];
	        this.resultType = source["resultType"];
	        this.result = source["result"];
	        this.content = this.convertValues(source["content"], McpContent);
	        this.structuredContent = source["structuredContent"];
	        this.isError = source["isError"];
	        this.tools = this.convertValues(source["tools"], McpTool);
	        this.resources = this.convertValues(source["resources"], McpResource);
	        this.prompts = this.convertValues(source["prompts"], McpPrompt);
	        this.nextCursor = source["nextCursor"];
	        this.ttlMs = source["ttlMs"];
	        this.cacheScope = source["cacheScope"];
	        this.inputRequests = source["inputRequests"];
	        this.requestState = source["requestState"];
	        this.notifications = this.convertValues(source["notifications"], McpNotification);
	        this.rpcErrorCode = source["rpcErrorCode"];
	        this.rpcErrorMessage = source["rpcErrorMessage"];
	        this.rpcErrorData = source["rpcErrorData"];
	        this.warnings = source["warnings"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class MockRequestLog {
	    id: string;
	    method: string;
	    path: string;
	    query: string;
	    matched: boolean;
	    exampleId?: string;
	    exampleName?: string;
	    requestName?: string;
	    note?: string;
	    statusCode: number;
	    durationMs: number;
	    timestamp: number;
	
	    static createFrom(source: any = {}) {
	        return new MockRequestLog(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.method = source["method"];
	        this.path = source["path"];
	        this.query = source["query"];
	        this.matched = source["matched"];
	        this.exampleId = source["exampleId"];
	        this.exampleName = source["exampleName"];
	        this.requestName = source["requestName"];
	        this.note = source["note"];
	        this.statusCode = source["statusCode"];
	        this.durationMs = source["durationMs"];
	        this.timestamp = source["timestamp"];
	    }
	}
	export class MockRoute {
	    exampleId: string;
	    exampleName: string;
	    requestId: string;
	    requestName: string;
	    method: string;
	    pathTemplate: string;
	    query: KeyValue[];
	    statusCode: number;
	    status: string;
	    headers: KeyValue[];
	    body: string;
	    bodyMediaType: string;
	    delayMs: number;
	
	    static createFrom(source: any = {}) {
	        return new MockRoute(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.exampleId = source["exampleId"];
	        this.exampleName = source["exampleName"];
	        this.requestId = source["requestId"];
	        this.requestName = source["requestName"];
	        this.method = source["method"];
	        this.pathTemplate = source["pathTemplate"];
	        this.query = this.convertValues(source["query"], KeyValue);
	        this.statusCode = source["statusCode"];
	        this.status = source["status"];
	        this.headers = this.convertValues(source["headers"], KeyValue);
	        this.body = source["body"];
	        this.bodyMediaType = source["bodyMediaType"];
	        this.delayMs = source["delayMs"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MockServerConfig {
	    port: number;
	    collectionId: string;
	    collectionName: string;
	    routes: MockRoute[];
	    simulateLatency: boolean;
	
	    static createFrom(source: any = {}) {
	        return new MockServerConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.port = source["port"];
	        this.collectionId = source["collectionId"];
	        this.collectionName = source["collectionName"];
	        this.routes = this.convertValues(source["routes"], MockRoute);
	        this.simulateLatency = source["simulateLatency"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MockServerStatus {
	    running: boolean;
	    port: number;
	    url: string;
	    collectionId: string;
	    collectionName: string;
	    routeCount: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new MockServerStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.port = source["port"];
	        this.url = source["url"];
	        this.collectionId = source["collectionId"];
	        this.collectionName = source["collectionName"];
	        this.routeCount = source["routeCount"];
	        this.error = source["error"];
	    }
	}
	export class OAuth2TokenResponse {
	    access_token: string;
	    token_type: string;
	    expires_in: number;
	    refresh_token?: string;
	    scope?: string;
	    id_token?: string;
	    error?: string;
	    error_description?: string;
	
	    static createFrom(source: any = {}) {
	        return new OAuth2TokenResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.access_token = source["access_token"];
	        this.token_type = source["token_type"];
	        this.expires_in = source["expires_in"];
	        this.refresh_token = source["refresh_token"];
	        this.scope = source["scope"];
	        this.id_token = source["id_token"];
	        this.error = source["error"];
	        this.error_description = source["error_description"];
	    }
	}
	
	
	
	export class SocketIOEmitMessage {
	    eventName: string;
	    args: string[];
	    namespace: string;
	    ack: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SocketIOEmitMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.eventName = source["eventName"];
	        this.args = source["args"];
	        this.namespace = source["namespace"];
	        this.ack = source["ack"];
	    }
	}
	export class SocketIOEmitResult {
	    ok: boolean;
	    ackId?: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new SocketIOEmitResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.ackId = source["ackId"];
	        this.error = source["error"];
	    }
	}
	
	
	export class UpdateInfo {
	    version: string;
	    releaseNotes: string;
	    publishedAt: string;
	    downloadUrl: string;
	    assetName: string;
	    sha256: string;
	    signatureUrl: string;
	    manualInstallUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.releaseNotes = source["releaseNotes"];
	        this.publishedAt = source["publishedAt"];
	        this.downloadUrl = source["downloadUrl"];
	        this.assetName = source["assetName"];
	        this.sha256 = source["sha256"];
	        this.signatureUrl = source["signatureUrl"];
	        this.manualInstallUrl = source["manualInstallUrl"];
	    }
	}
	export class UpdateCheckResult {
	    info?: UpdateInfo;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateCheckResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.info = this.convertValues(source["info"], UpdateInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class WebSocketSendMessage {
	    type: string;
	    data: string;
	    encoding?: string;
	    code?: number;
	
	    static createFrom(source: any = {}) {
	        return new WebSocketSendMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.data = source["data"];
	        this.encoding = source["encoding"];
	        this.code = source["code"];
	    }
	}
	export class WebSocketSendResult {
	    ok: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new WebSocketSendResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.error = source["error"];
	    }
	}

}

