import * as ppa from "@msrvida/python-program-analysis";
import * as vscode from "vscode";
import { Constants, IGatherProvider, SimpleCell, Telemetry } from "./types/types";
import { arePathsSame, concat, convertVscToGatherCell, countCells, createNotebookContent, generateCellsFromString, pathExists, splitLines, StopWatch } from "./helpers";
import * as util from "util";
import * as localize from './localize';
import { sendTelemetryEvent } from "./telemetry";
import { IDisposable } from 'monaco-editor';

export class GatherProvider implements IGatherProvider {
  private _executionSlicer: ppa.ExecutionLogSlicer<ppa.Cell> | undefined;
  private dataflowAnalyzer: ppa.DataflowAnalyzer | undefined;
  private initPromise: Promise<void>;
  private gatherTimer: StopWatch | undefined;
  private linesSubmitted: number = 0;
  private cellsSubmitted: number = 0;

  constructor(private readonly languages: string[]) {
    this.initPromise = this.init();
  }

  public async getLogLength(): Promise<number | undefined> {
    await this.initPromise;

    if (this._executionSlicer) {
      return this._executionSlicer.executionLog.length;
    }
  }

  public async logExecution(vscCell: vscode.NotebookCell): Promise<void> {
    try {
      if (vscCell && vscCell.document) {
        const lineCount: number = vscCell.document.getText().length as number;
        this.linesSubmitted += lineCount;
        this.cellsSubmitted += 1;
      }
      await this.initPromise;

      if (vscCell.language === Constants.PYTHON_LANGUAGE) {
        const gatherCell = convertVscToGatherCell(vscCell);

        if (gatherCell) {
          if (this._executionSlicer) {
            this._executionSlicer.logExecution(gatherCell);
          }
        }
      }

      // if (vscCell.language === 'C#') {
      //   C# work
      // }
    } catch (e) {
      sendTelemetryEvent(Telemetry.GatherException, undefined, { exceptionType: 'log' });
      vscode.window.showErrorMessage("Gather: Error logging execution on cell:\n" + vscCell.document.getText(), e);
      throw e;
    }
  }

  public async resetLog(): Promise<void> {
    try {
      this.linesSubmitted = 0;
      this.cellsSubmitted = 0;
      await this.initPromise;

      if (this.languages.includes(Constants.PYTHON_LANGUAGE)) {
        if (this._executionSlicer) {
          this._executionSlicer.reset();
        }
      }
      
      // if (this.languages.includes(C#)) {
      //   C# work
      // }
    } catch (e) {
      sendTelemetryEvent(Telemetry.GatherException, undefined, { exceptionType: 'reset' });
      vscode.window.showErrorMessage("Gather: Error resetting log", e);
      throw e;
    }
  }

  /**
   * For a given code cell, returns a string representing a program containing all the code it depends on.
   */
  public async gatherCode(vscCell: vscode.NotebookCell, toScript: boolean = false, preview: boolean = false): Promise<void> {
      this.gatherTimer = new StopWatch();
      const gatheredCode = this.gatherCodeInternal(vscCell);
      const settings = vscode.workspace.getConfiguration();
      const gatherToScript: boolean = settings.get(Constants.gatherToScriptSetting) as boolean || toScript;

      if (gatherToScript) {
        await this.showFile(gatheredCode, vscCell.notebook.fileName);
        sendTelemetryEvent(Telemetry.GatherCompleted, this.gatherTimer?.elapsedTime, { result: 'script' });
      } else {
        await this.showNotebook(gatheredCode, preview);
        sendTelemetryEvent(Telemetry.GatherCompleted, this.gatherTimer?.elapsedTime, { result: 'notebook' });
      }

      sendTelemetryEvent(Telemetry.GatherStats, undefined, {
        linesSubmitted: this.linesSubmitted,
        cellsSubmitted: this.cellsSubmitted,
        linesGathered: splitLines(gatheredCode.trim()).length,
        cellsGathered: countCells(splitLines(gatheredCode.trim()))
      });
  }

  private gatherCodeInternal(vscCell: vscode.NotebookCell): string {
    try {
      if (vscCell.language === Constants.PYTHON_LANGUAGE) {
        if (!this._executionSlicer) {
          return "# %% [markdown]\n## Gather not available";
        }

        const gatherCell = convertVscToGatherCell(vscCell);
        if (!gatherCell) {
          return "";
        }

        const settings = vscode.workspace.getConfiguration();
        const defaultCellMarker: string = settings ?
          settings.get(Constants.defaultCellMarkerSetting) as string :
          Constants.DefaultCodeCellMarker;

        // Call internal slice method
        const slice = this._executionSlicer.sliceLatestExecution(gatherCell.persistentId);

        return slice.cellSlices
          .reduce(concat, "")
          .replace(/#%%/g, defaultCellMarker)
          .trim();
      }

      // if (vscCell.language === 'C#') {
      //   C# work
      // }

      return '# %% [markdown]\n## Gather not available in ' + vscCell.language;
    } catch (e) {
      vscode.window.showErrorMessage('Gather: Exception at gatherCode', e);
      sendTelemetryEvent(Telemetry.GatherException, undefined, { exceptionType: 'gather' });
      const newline = '\n';
      const settings = vscode.workspace.getConfiguration();
      const defaultCellMarker = settings ? 
        settings.get(Constants.defaultCellMarkerSetting) as string :
        Constants.DefaultCodeCellMarker;
      return defaultCellMarker + newline + localize.Common.gatherError() + newline + (e as string);
    }
  }

  private async init(): Promise<void> {
    if (this.languages.includes(Constants.PYTHON_LANGUAGE)) {
      try {
        if (ppa) {
          const settings = vscode.workspace.getConfiguration();
          let additionalSpecPath: string | undefined;
          if (settings) {
            additionalSpecPath = settings.get(Constants.gatherSpecPathSetting);
          }
  
          if (additionalSpecPath && (await pathExists(additionalSpecPath))) {
            ppa.addSpecFolder(additionalSpecPath);
          } else {
            console.error(`Gather: additional spec folder ${additionalSpecPath} but not found.`);
          }
  
          // Only continue to initialize gather if we were successful in finding SOME specs.
          if (ppa.getSpecs()) {
            this.dataflowAnalyzer = new ppa.DataflowAnalyzer();
            this._executionSlicer = new ppa.ExecutionLogSlicer(this.dataflowAnalyzer);
          } else {
            console.error("Gather couldn't find any package specs.");
          }
        }
      } catch (ex) {
        console.error(`Gathering tools could't be activated. ${util.format(ex)}`);
        throw ex;
      }
    }

    // if (this.languages.includes('C#')) {
    //   C# work
    // }
  }

  private async showFile(gatheredCode: string, filename: string) {
    const settings = vscode.workspace.getConfiguration();
    const defaultCellMarker: string = settings ?
      settings.get(Constants.defaultCellMarkerSetting) as string :
      Constants.DefaultCodeCellMarker;

    if (gatheredCode) {
      // Remove all cell definitions and newlines
      const re = new RegExp(`^(${defaultCellMarker}.*|\\s*)\n`, 'gm');
      gatheredCode = gatheredCode.replace(re, '');
    }

    const annotatedScript = `${localize.Common.gatheredScriptDescription()}${defaultCellMarker}\n${gatheredCode}`;

    // Don't want to open the gathered code on top of the interactive window
    let viewColumn: vscode.ViewColumn | undefined;
    const fileNameMatch = vscode.window.visibleTextEditors.filter((textEditor) =>
      arePathsSame(textEditor.document.fileName, filename)
    );
    const definedVisibleEditors = vscode.window.visibleTextEditors.filter(
        (textEditor) => textEditor.viewColumn !== undefined
    );
    if (vscode.window.visibleTextEditors.length > 0 && fileNameMatch.length > 0) {
        // Original file is visible
        viewColumn = fileNameMatch[0].viewColumn;
    } else if (vscode.window.visibleTextEditors.length > 0 && definedVisibleEditors.length > 0) {
        // There is a visible text editor, just not the original file. Make sure viewColumn isn't undefined
        viewColumn = definedVisibleEditors[0].viewColumn;
    } else {
        // Only one panel open and interactive window is occupying it, or original file is open but hidden
        viewColumn = vscode.ViewColumn.Beside;
    }

    const textDoc = await vscode.workspace.openTextDocument({ language: Constants.PYTHON_LANGUAGE, content: annotatedScript });
    await vscode.window.showTextDocument(textDoc, viewColumn, true);
  }

  private async showNotebook(gatheredCode: string, preview: boolean) {
    let cells: SimpleCell[] = [
      {
        source: localize.Common.gatheredNotebookDescriptionInMarkdown(),
        type: 'markdown'
      }
    ];
    cells = cells.concat(generateCellsFromString(gatheredCode));
    let file = vscode.Uri.parse(createNotebookContent(cells));
    let editor: any;

    if (preview) {
      editor = await vscode.commands.executeCommand(Constants.openPreviewNotebookCommand, file);
    } else {
      editor = await vscode.commands.executeCommand(Constants.openNotebookCommand, file);
    }
    
    let disposableNotebookSaved: IDisposable;
    let disposableNotebookClosed: IDisposable;

    const savedHandler = () => {
        sendTelemetryEvent(Telemetry.GatheredNotebookSaved);
        if (disposableNotebookSaved) {
            disposableNotebookSaved.dispose();
        }
        if (disposableNotebookClosed) {
            disposableNotebookClosed.dispose();
        }
    };

    const closedHandler = () => {
        if (disposableNotebookSaved) {
            disposableNotebookSaved.dispose();
        }
        if (disposableNotebookClosed) {
            disposableNotebookClosed.dispose();
        }
    };

    disposableNotebookSaved = editor.saved(savedHandler);
    disposableNotebookClosed = editor.closed(closedHandler);
  }
}
