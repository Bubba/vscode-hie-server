'use strict';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as url from 'url';
import {
  commands,
  ExtensionContext,
  OutputChannel,
  TextDocument,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  TransportKind,
  VersionedTextDocumentIdentifier,
} from 'vscode-languageclient';
import { ImportIdentifier } from './commands/importIdentifier';
import { InsertType } from './commands/insertType';
import { RestartHie } from './commands/restartHie';
import { ShowTypeCommand, ShowTypeHover } from './commands/showType';
import { DocsBrowser } from './docsBrowser';
import { downloadFile, userAgentHeader } from './download';

let docsBrowserRegistered: boolean = false;
let hieCommandsRegistered: boolean = false;
const clients: Map<string, LanguageClient> = new Map();

/** GitHub API release */
interface IRelease {
  assets: [IAsset];
  tag_name: string;
  prerelease: boolean;
}
/** GitHub API asset */
interface IAsset {
  browser_download_url: string;
  name: string;
}

export async function activate(context: ExtensionContext) {
  // Register HIE to check every time a text document gets opened, to
  // support multi-root workspaces.
  workspace.onDidOpenTextDocument(async (document: TextDocument) => await activateHie(context, document));
  workspace.textDocuments.forEach(async (document: TextDocument) => await activateHie(context, document));

  console.log('activate');

  // Stop HIE from any workspace folders that are removed.
  workspace.onDidChangeWorkspaceFolders((event) => {
    for (const folder of event.removed) {
      const client = clients.get(folder.uri.toString());
      if (client) {
        clients.delete(folder.uri.toString());
        client.stop();
      }
    }
  });
}

async function getProjectGhcVersion(context: ExtensionContext, release: IRelease): Promise<string | null> {
  const localWrapper = ['haskell-language-server-wrapper', 'haskell-ide-engine-wrapper'].find(executableExists);
  if (localWrapper) {
    // Need to set the encoding to 'utf8' in order to get back a string
    const out = child_process.spawnSync(localWrapper, ['--project-ghc-version'], { encoding: 'utf8' });
    return !out.error ? out.stdout.trim() : null;
  }

  // Otherwise find and download the wrapper

  const githubOS = getGithubOS();
  if (githubOS === null) {
    // Don't have any binaries available for this platform
    window.showErrorMessage(`Couldn't find any haskell-language-server-wrapper binaries for ${process.platform}`);
    return null;
  }
  const wrapperAsset = release.assets.find((x) => x.name === `haskell-language-server-wrapper-${githubOS}`);

  if (!wrapperAsset) {
    return null;
  }

  const wrapperName = `haskell-language-server-wrapper-${release.tag_name}-${process.platform}`;
  const dest = path.join(context.globalStoragePath, wrapperName);
  const wrapperUrl = url.parse(wrapperAsset.browser_download_url);

  const downloadedWrapper = await downloadFile('Downloading haskell-language-server-wrapper', wrapperUrl, dest);
  if (!downloadedWrapper) {
    return null;
  }

  const out2 = child_process.spawnSync(downloadedWrapper, ['--project-ghc-version'], { encoding: 'utf8' });
  return !out2.error ? out2.stdout.trim() : null;
}

/** Searches the PATH for whatever is set in hieVariant as well as whatever's in hieExecutablePath */
function findLocalServer(context: ExtensionContext, uri: Uri, folder?: WorkspaceFolder): string | null {
  const hieVariant = workspace.getConfiguration('languageServerHaskell', uri).hieVariant;
  let hieExecutablePath = workspace.getConfiguration('languageServerHaskell', uri).hieExecutablePath;

  // Substitute path variables with their corresponding locations.
  if (hieExecutablePath !== '') {
    hieExecutablePath = hieExecutablePath
      .replace('${HOME}', os.homedir)
      .replace('${home}', os.homedir)
      .replace(/^~/, os.homedir);
    if (folder) {
      hieExecutablePath = hieExecutablePath
        .replace('${workspaceFolder}', folder.uri.path)
        .replace('${workspaceRoot}', folder.uri.path);
    }
    return hieExecutablePath;
  }

  // Set the executable, based on the settings.
  let serverExecutable = 'hie'; // should get set below
  switch (hieVariant) {
    case 'haskell-ide-engine':
      serverExecutable = 'hie-wrapper';
      break;
    case 'haskell-language-server':
      serverExecutable = 'haskell-language-server-wrapper';
      break;
    case 'ghcide':
      serverExecutable = 'ghcide';
      break;
  }
  if (hieExecutablePath !== '') {
    serverExecutable = hieExecutablePath;
  }

  if (executableExists(serverExecutable)) {
    return serverExecutable;
  }

  return null;
}

/** The OS label used by GitHub */
function getGithubOS(): string | null {
  function platformToGithubOS(x: string): string | null {
    switch (x) {
      case 'darwin':
        return 'macOS';
      case 'linux':
        return 'Linux';
      case 'win32':
        return 'Windows';
      default:
        return null;
    }
  }

  return platformToGithubOS(process.platform);
}

async function downloadServer(context: ExtensionContext, releases: IRelease[]): Promise<string | null> {
  // fetch the latest release from GitHub

  console.log('download server');

  const githubOS = getGithubOS();
  if (githubOS === null) {
    // Don't have any binaries available for this platform
    window.showErrorMessage(`Couldn't find any haskell-language-server binaries for ${process.platform}`);
    return null;
  }

  // const release = releases.find(x => !x.prerelease);
  const release = releases[0];

  const ghcVersion = await getProjectGhcVersion(context, release);
  if (!ghcVersion) {
    window.showErrorMessage("Couldn't figure out what GHC version the project is using");
    // We couldn't figure out the right ghc version to download
    return null;
  }

  const asset = release?.assets.find((x) => x.name.includes(githubOS) && x.name.includes(ghcVersion));
  if (!release || !asset) {
    return null;
  }
  const binaryURL = url.parse(asset.browser_download_url);

  if (!fs.existsSync(context.globalStoragePath)) {
    fs.mkdirSync(context.globalStoragePath);
  }

  const serverName = `haskell-language-server-${release.tag_name}-${process.platform}-${ghcVersion}`;
  const binaryDest = path.join(context.globalStoragePath, serverName);

  if (fs.existsSync(binaryDest)) {
    return binaryDest;
  }

  const title = `Downloading haskell-language-server ${release.tag_name} for GHC ${ghcVersion}`;
  return downloadFile(title, binaryURL, binaryDest);
}

async function activateHie(context: ExtensionContext, document: TextDocument) {
  // We are only interested in Haskell files.
  if (
    (document.languageId !== 'haskell' &&
      document.languageId !== 'cabal' &&
      document.languageId !== 'literate Haskell') ||
    (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')
  ) {
    return;
  }

  const uri = document.uri;
  const folder = workspace.getWorkspaceFolder(uri);

  // If the client already has an LSP server for this folder, then don't start a new one.
  if (folder && clients.has(folder.uri.toString())) {
    return;
  }

  // try {
  //   const hieVariant = workspace.getConfiguration('languageServerHaskell', uri).hieVariant;
  //   const hieExecutablePath = workspace.getConfiguration('languageServerHaskell', uri).hieExecutablePath;
  //   // Check if hie is installed.
  //   let exeName = 'hie';
  //   switch (hieVariant) {
  //     case 'haskell-ide-engine':
  //       break;
  //     case 'haskell-language-server':
  //     case 'ghcide':
  //       exeName = hieVariant;
  //       break;
  //   }
  //   if (!await isHieInstalled(exeName) && hieExecutablePath === '') {
  //     // TODO: Once haskell-ide-engine is on hackage/stackage, enable an option to install it via cabal/stack.
  //     let hieProjectUrl = '/haskell/haskell-ide-engine';
  //     switch (hieVariant) {
  //       case 'haskell-ide-engine':
  //         break;
  //       case 'haskell-language-server':
  //         hieProjectUrl = '/haskell/haskell-language-server';
  //         break;
  //       case 'ghcide':
  //         hieProjectUrl = '/digital-asset/ghcide';
  //         break;
  //     }
  //     const notInstalledMsg: string =
  //       exeName + ' executable missing, please make sure it is installed, see https://github.com' + hieProjectUrl + '.';
  //     const forceStart: string = 'Force Start';
  //     window.showErrorMessage(notInstalledMsg, forceStart).then(option => {
  //       if (option === forceStart) {
  //         activateHieNoCheck(context, uri, folder);
  //       }
  //     });
  //   } else {
  //     activateHieNoCheck(context, uri, folder);
  //   }
  // } catch (e) {
  //   console.error(e);
  // }
  activateHieNoCheck(context, uri, folder);
}

async function activateHieNoCheck(context: ExtensionContext, uri: Uri, folder?: WorkspaceFolder) {
  // Stop right here, if HIE is disabled in the resource/workspace folder.
  const enableHIE = workspace.getConfiguration('languageServerHaskell', uri).enableHIE;
  if (!enableHIE) {
    return;
  }

  // Set up the documentation browser.
  if (!docsBrowserRegistered) {
    const docsDisposable = DocsBrowser.registerDocsBrowser();
    context.subscriptions.push(docsDisposable);
    docsBrowserRegistered = true;
  }

  const logLevel = workspace.getConfiguration('languageServerHaskell', uri).trace.server;
  const logFile = workspace.getConfiguration('languageServerHaskell', uri).logFile;

  const releases: IRelease[] = await new Promise((resolve, reject) => {
    let data: string = '';
    const opts: https.RequestOptions = {
      host: 'api.github.com',
      path: '/repos/bubba/haskell-language-server/releases',
      headers: userAgentHeader,
    };
    https.get(opts, (res) => {
      res.on('data', (d) => (data += d));
      res.on('error', reject);
      res.on('close', () => {
        resolve(JSON.parse(data));
      });
    });
  });

  console.log(release);

  const serverExecutable = findLocalServer(context, uri, folder) ?? (await downloadServer(context, releases));
  if (serverExecutable === null) {
    return;
  }

  const runArgs: string[] = ['--lsp'];
  let debugArgs: string[] = ['--lsp'];

  const hieVariant = workspace.getConfiguration('languageServerHaskell', uri).hieVariant;
  // ghcide does not accept -d and -l params
  if (hieVariant !== 'ghcide') {
    if (logLevel === 'messages') {
      debugArgs = debugArgs.concat(['-d']);
    }

    if (logFile !== '') {
      debugArgs = debugArgs.concat(['-l', logFile]);
    }
  }

  // If the extension is launched in debug mode then the debug server options are used,
  // otherwise the run options are used.
  const serverOptions: ServerOptions = {
    run: { command: serverExecutable, transport: TransportKind.stdio, args: runArgs },
    debug: { command: serverExecutable, transport: TransportKind.stdio, args: debugArgs },
  };

  // Set a unique name per workspace folder (useful for multi-root workspaces).
  const langName = 'Haskell' + (folder ? ` (${folder.name})` : '');
  const outputChannel: OutputChannel = window.createOutputChannel(langName);
  outputChannel.appendLine('[client] run command = "' + serverExecutable + ' ' + runArgs.join(' ') + '"');
  outputChannel.appendLine('[client] debug command = "' + serverExecutable + ' ' + debugArgs.join(' ') + '"');
  const pat = folder ? `${folder.uri.fsPath}/**/*` : '**/*';
  const clientOptions: LanguageClientOptions = {
    // Use the document selector to only notify the LSP on files inside the folder
    // path for the specific workspace.
    documentSelector: [
      { scheme: 'file', language: 'haskell', pattern: pat },
      { scheme: 'file', language: 'literate haskell', pattern: pat },
    ],
    synchronize: {
      // Synchronize the setting section 'languageServerHaskell' to the server.
      configurationSection: 'languageServerHaskell',
      // Notify the server about file changes to '.clientrc files contain in the workspace.
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
    },
    diagnosticCollectionName: langName,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    outputChannel,
    outputChannelName: langName,
    middleware: {
      provideHover: DocsBrowser.hoverLinksMiddlewareHook,
    },
    // Set the current working directory, for HIE, to be the workspace folder.
    workspaceFolder: folder,
  };

  // Create the LSP client.
  const langClient = new LanguageClient(langName, langName, serverOptions, clientOptions, true);

  // Register ClientCapabilities for stuff like window/progress
  langClient.registerProposedFeatures();

  if (workspace.getConfiguration('languageServerHaskell', uri).showTypeForSelection.onHover) {
    context.subscriptions.push(ShowTypeHover.registerTypeHover(clients));
  }
  // Register editor commands for HIE, but only register the commands once.
  if (!hieCommandsRegistered) {
    context.subscriptions.push(InsertType.registerCommand(clients));
    context.subscriptions.push(RestartHie.registerCommand(clients));
    const showTypeCmd = ShowTypeCommand.registerCommand(clients);
    if (showTypeCmd !== null) {
      showTypeCmd.forEach((x) => context.subscriptions.push(x));
    }
    context.subscriptions.push(ImportIdentifier.registerCommand());
    registerHiePointCommand('hie.commands.demoteDef', 'hare:demote', context);
    registerHiePointCommand('hie.commands.liftOneLevel', 'hare:liftonelevel', context);
    registerHiePointCommand('hie.commands.liftTopLevel', 'hare:lifttotoplevel', context);
    registerHiePointCommand('hie.commands.deleteDef', 'hare:deletedef', context);
    registerHiePointCommand('hie.commands.genApplicative', 'hare:genapplicative', context);
    registerHiePointCommand('hie.commands.caseSplit', 'hare:casesplit', context);
    hieCommandsRegistered = true;
  }

  // If the client already has an LSP server, then don't start a new one.
  // We check this again, as there may be multiple parallel requests.
  if (folder && clients.has(folder.uri.toString())) {
    return;
  }

  // Finally start the client and add it to the list of clients.
  langClient.start();
  if (folder) {
    clients.set(folder.uri.toString(), langClient);
  }
}

/*
 * Deactivate each of the LSP servers.
 */
export function deactivate(): Thenable<void> {
  const promises: Array<Thenable<void>> = [];
  for (const client of clients.values()) {
    promises.push(client.stop());
  }
  return Promise.all(promises).then(() => undefined);
}

/*
 * Checks if the executable is on the PATH
 */
function executableExists(exe: string): boolean {
  const cmd: string = process.platform === 'win32' ? 'where ' : 'which ' + exe;
  const out = child_process.spawnSync(cmd);
  return out.error === null;
}

/*
 * Create an editor command that calls an action on the active LSP server.
 */
async function registerHiePointCommand(name: string, command: string, context: ExtensionContext) {
  const editorCmd = commands.registerTextEditorCommand(name, (editor, edit) => {
    const cmd = {
      command,
      arguments: [
        {
          file: editor.document.uri.toString(),
          pos: editor.selections[0].active,
        },
      ],
    };
    // Get the current file and workspace folder.
    const uri = editor.document.uri;
    const folder = workspace.getWorkspaceFolder(uri);
    // If there is a client registered for this workspace, use that client.
    if (folder !== undefined && clients.has(folder.uri.toString())) {
      const client = clients.get(folder.uri.toString());
      if (client !== undefined) {
        client.sendRequest('workspace/executeCommand', cmd).then(
          (hints) => {
            return true;
          },
          (e) => {
            console.error(e);
          }
        );
      }
    }
  });
  context.subscriptions.push(editorCmd);
}
