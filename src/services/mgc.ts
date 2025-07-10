import { exec } from 'child_process';
import { promisify } from 'util';
import { CalendarEvent } from '../types/calendar.js';
import chalk from 'chalk';

const execAsync = promisify(exec);

export class MgcService {
  private mgcChecked = false;
  private mgcAvailable = false;

  private async checkMgcInstalled(): Promise<boolean> {
    if (this.mgcChecked) {
      return this.mgcAvailable;
    }

    try {
      await execAsync('command -v mgc');
      this.mgcAvailable = true;
    } catch {
      this.mgcAvailable = false;
    }
    this.mgcChecked = true;
    return this.mgcAvailable;
  }

  async executeCommand(command: string): Promise<any> {
    try {
      // mgcコマンドの存在確認
      if (!await this.checkMgcInstalled()) {
        throw new Error(
          'Microsoft Graph CLI (mgc) is not installed.\n' +
          'Please install it first: https://github.com/microsoftgraph/msgraph-cli\n' +
          'Installation: brew install mgc (macOS) or see documentation for other platforms'
        );
      }

      // デバッグ用にコマンドを出力
      if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
        console.log(chalk.gray('\nExecuting:'), chalk.cyan(command.substring(0, 200) + (command.length > 200 ? '...' : '')));
      }
      
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });
      
      // stderrの処理を改善
      if (stderr) {
        const isWarning = stderr.toLowerCase().includes('warning') || 
                         stderr.toLowerCase().includes('deprecated');
        const isError = stderr.toLowerCase().includes('error') || 
                       stderr.toLowerCase().includes('failed') ||
                       stderr.toLowerCase().includes('unauthorized') ||
                       stderr.toLowerCase().includes('forbidden');
        
        if (isError) {
          // エラーの場合は例外として投げる
          throw new Error(`MGC command error: ${stderr}`);
        } else if (isWarning) {
          // 警告の場合はデバッグモードでのみ表示
          if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
            console.warn(chalk.yellow('⚠️  MGC warning:'), stderr);
          }
        } else {
          // その他の場合も念のため表示
          console.error(chalk.yellow('MGC stderr:'), stderr);
        }
      }
      // キャンセルAPIは "Success" を返すことがある
      if (stdout.trim() === 'Success') {
        return { success: true };
      }
      
      // JSON解析を試みる
      let result;
      try {
        result = JSON.parse(stdout);
      } catch (parseError) {
        // JSON解析に失敗した場合、stdout全体をエラーメッセージとして扱う
        if (stdout.toLowerCase().includes('error') || 
            stdout.toLowerCase().includes('failed')) {
          throw new Error(`MGC command returned error: ${stdout}`);
        }
        // 解析できないが正常な応答の可能性もある
        throw new Error(`Failed to parse MGC response: ${stdout.substring(0, 500)}`);
      }

      // APIエラーのチェック
      if (result.error) {
        const errorDetails = [
          `Code: ${result.error.code}`,
          `Message: ${result.error.message}`
        ];
        if (result.error.innerError) {
          errorDetails.push(`Inner Error: ${JSON.stringify(result.error.innerError)}`);
        }
        throw new Error(`Microsoft Graph API Error\n${errorDetails.join('\n')}`);
      }
      
      // デバッグ: 結果を出力
      if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
        console.log(chalk.gray('Result:'), JSON.stringify(result, null, 2));
      }
      
      return result;
    } catch (error: any) {
      // エラーの詳細情報を保持
      const enhancedError = new Error(
        error.message?.includes('API Error:') || 
        error.message?.includes('Microsoft Graph API Error') ||
        error.message?.includes('MGC command error:') ||
        error.message?.includes('is not installed') ?
          error.message : 
          `MGC command failed: ${error.message || error}`
      );
      
      // 元のエラー情報を保持
      if (error.stack) {
        enhancedError.stack = error.stack;
      }
      if (error.cause) {
        enhancedError.cause = error.cause;
      }
      
      // デバッグモードで詳細情報を表示
      if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
        console.error(chalk.red('\nError details:'));
        console.error(chalk.gray('Message:'), error.message);
        if (error.code) {
          console.error(chalk.gray('Code:'), error.code);
        }
        if (error.stack && error.stack !== enhancedError.stack) {
          console.error(chalk.gray('Original stack:'), error.stack);
        }
      }
      
      throw enhancedError;
    }
  }

  async getMyCalendarEvents(startDate: string, endDate: string, excludeDeclined: boolean = false): Promise<CalendarEvent[]> {
    const command = `mgc me calendar-view list \
      --headers 'Prefer=outlook.timezone="Asia/Tokyo"' \
      --select "id,subject,start,end,location,responseStatus,attendees,isAllDay,isCancelled,showAs" \
      --start-date-time "${startDate}" \
      --end-date-time "${endDate}" \
      --filter "isCancelled eq false" \
      --orderby "isAllDay,start/dateTime" \
      --top 250`;

    const result = await this.executeCommand(command);
    const events = result.value || [];
    
    if (excludeDeclined) {
      return events.filter((event: CalendarEvent) => 
        !event.responseStatus || event.responseStatus.response !== 'declined'
      );
    }
    
    return events;
  }

  async checkAuth(): Promise<boolean> {
    try {
      // mgcコマンドの存在確認を先に行う
      if (!await this.checkMgcInstalled()) {
        return false;
      }
      
      await execAsync('mgc me get --select id');
      return true;
    } catch (error: any) {
      // デバッグモードでエラー詳細を表示
      if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
        console.error(chalk.gray('\nAuth check failed:'));
        console.error(chalk.gray(error.message));
      }
      return false;
    }
  }

  async getCurrentUser(): Promise<{ id: string; mail: string; displayName: string }> {
    const command = 'mgc me get --select "id,mail,displayName"';
    const result = await this.executeCommand(command);
    return result;
  }

  async getUserCalendarEvents(userEmail: string, startDate: string, endDate: string): Promise<CalendarEvent[]> {
    // まず共有カレンダーとして試す
    try {
      const sharedCommand = `mgc me calendars list --filter "owner/address eq '${userEmail}'"`;
      const calendarsResult = await this.executeCommand(sharedCommand);
      
      if (calendarsResult.value && calendarsResult.value.length > 0) {
        // 共有カレンダーが見つかった場合
        const calendarId = calendarsResult.value[0].id;
        const eventsCommand = `mgc me calendars ${calendarId} calendar-view list \
          --headers 'Prefer=outlook.timezone="Asia/Tokyo"' \
          --select "id,subject,start,end,location,responseStatus,attendees,isAllDay,isCancelled" \
          --start-date-time "${startDate}" \
          --end-date-time "${endDate}" \
          --filter "isCancelled eq false" \
          --orderby "isAllDay,start/dateTime" \
          --top 50`;
        
        const result = await this.executeCommand(eventsCommand);
        return result.value || [];
      }
    } catch (error) {
      // 共有カレンダーアクセスに失敗した場合は次の方法を試す
      if (process.env.DEBUG) {
        console.log('Shared calendar access failed, trying direct access...');
      }
    }

    // 直接アクセスを試す（組織内で権限がある場合）
    const command = `mgc users calendar-view list \
      --user-id "${userEmail}" \
      --headers 'Prefer=outlook.timezone="Asia/Tokyo"' \
      --select "id,subject,start,end,location,responseStatus,attendees,isAllDay,isCancelled" \
      --start-date-time "${startDate}" \
      --end-date-time "${endDate}" \
      --filter "isCancelled eq false" \
      --orderby "isAllDay,start/dateTime" \
      --top 50`;

    const result = await this.executeCommand(command);
    return result.value || [];
  }

  async getRecentEventsWithAttendees(): Promise<CalendarEvent[]> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30); // 過去30日間

    const formatDate = (date: Date) => {
      const offset = date.getTimezoneOffset();
      const offsetHours = Math.abs(Math.floor(offset / 60));
      const offsetMinutes = Math.abs(offset % 60);
      const offsetSign = offset <= 0 ? '+' : '-';
      const offsetString = `${offsetSign}${offsetHours.toString().padStart(2, '0')}:${offsetMinutes.toString().padStart(2, '0')}`;
      
      return date.toISOString().slice(0, -5) + offsetString;
    };

    const command = `mgc me calendar-view list \
      --headers 'Prefer=outlook.timezone="Asia/Tokyo"' \
      --select "id,subject,start,end,attendees" \
      --start-date-time "${formatDate(startDate)}" \
      --end-date-time "${formatDate(endDate)}" \
      --filter "isCancelled eq false" \
      --top 100`;

    const result = await this.executeCommand(command);
    return result.value || [];
  }

  async getContactGroups(): Promise<any[]> {
    const command = 'mgc me contact-folders list --select "id,displayName"';
    const result = await this.executeCommand(command);
    return result.value || [];
  }

  async getContactGroupMembers(groupId: string): Promise<any[]> {
    const command = `mgc me contact-folders ${groupId} contacts list \
      --select "emailAddresses,displayName" \
      --top 100`;
    const result = await this.executeCommand(command);
    return result.value || [];
  }

  async createContactGroup(displayName: string): Promise<string> {
    const command = `mgc me contact-folders create --body '{"displayName": "${displayName}"}'`;
    const result = await this.executeCommand(command);
    return result.id;
  }

  async createEvent(eventData: {
    subject: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    location?: { displayName: string };
    attendees?: Array<{ emailAddress: { address: string; name?: string } }>;
    body?: { contentType: string; content: string };
  }): Promise<string> {
    const body = JSON.stringify(eventData);
    const command = `mgc me events create --body '${body}'`;
    const result = await this.executeCommand(command);
    return result.id;
  }

  async findMeetingTimes(data: {
    attendees: Array<{ emailAddress: { address: string } }>;
    timeConstraint: {
      timeslots: Array<{
        start: { dateTime: string; timeZone: string };
        end: { dateTime: string; timeZone: string };
      }>;
    };
    meetingDuration: string; // ISO 8601 duration format (e.g., "PT30M")
    maxCandidates?: number;
  }): Promise<any> {
    const body = JSON.stringify(data);
    const command = `mgc me find-meeting-times post --body '${body}'`;
    return await this.executeCommand(command);
  }

  async getUserFreeBusy(emails: string[], startTime: string, endTime: string): Promise<any> {
    const data = {
      schedules: emails,
      startTime: { dateTime: startTime, timeZone: 'Asia/Tokyo' },
      endTime: { dateTime: endTime, timeZone: 'Asia/Tokyo' },
      availabilityViewInterval: 30
    };
    
    if (process.env.DEBUG) {
      console.log('Free/Busy request:', JSON.stringify(data, null, 2));
    }
    
    const body = JSON.stringify(data);
    const command = `mgc me calendar get-schedule post --body '${body}'`;
    const result = await this.executeCommand(command);
    
    if (process.env.DEBUG && result.value?.[0]) {
      const schedule = result.value[0];
      if (schedule.scheduleItems?.length > 0) {
        const firstItem = schedule.scheduleItems[0];
        console.log('First busy item sample:', JSON.stringify(firstItem, null, 2));
        console.log('Date comparison:');
        console.log('  Raw dateTime:', firstItem.start.dateTime);
        console.log('  Parsed as:', new Date(firstItem.start.dateTime + 'Z').toString());
        console.log('  In JST:', new Date(firstItem.start.dateTime + 'Z').toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
      }
      
      // Also log availability view if present
      if (schedule.availabilityView) {
        console.log('\nAvailability view length:', schedule.availabilityView.length, 'chars (', schedule.availabilityView.length / 48, 'days)');
        console.log('Availability view (first 48 chars):', schedule.availabilityView.substring(0, 48));
        console.log('Legend: 0=Free, 1=Tentative, 2=Busy, 3=OOF, 4=WorkingElsewhere');
        
        const requestStart = new Date(startTime);
        
        // Debug specific slots
        console.log(`\nDEBUG: Slot 225 (7/7 18:00 JST) = '${schedule.availabilityView.charAt(225)}'`);
        console.log(`Context around slot 225: "${schedule.availabilityView.substring(220, 230)}"`);
        
        console.log(`\nDEBUG: Slot 300 (7/9 17:30 JST) = '${schedule.availabilityView.charAt(300)}'`);
        console.log(`Context around slot 300: "${schedule.availabilityView.substring(295, 305)}"`);
        
        // What time does slot 300 represent?
        const slot300time = new Date(requestStart.getTime() + 300 * 30 * 60 * 1000);
        console.log(`Slot 300 = ${slot300time.toISOString()} (${slot300time.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })})`);
        
        // 7/7の表示
        const date77 = new Date('2025-07-07T00:00:00+09:00');
        const days77 = Math.floor((date77.getTime() - requestStart.getTime()) / (24 * 60 * 60 * 1000));
        const actualDayStart = Math.floor((date77.getTime() - 9 * 60 * 60 * 1000 - requestStart.getTime()) / (1000 * 60 * 30));
        console.log(`\n7/7 calculation: days77=${days77}, dayStart77=${days77 * 48}, actualDayStart=${actualDayStart}`);
        
        if (days77 >= 0 && schedule.availabilityView.length > (days77 + 1) * 48) {
          const dayStart77 = days77 * 48;
          const dayView77 = schedule.availabilityView.substring(dayStart77, dayStart77 + 48);
          console.log(`\n7/7 availability (00:00-23:30): ${dayView77}`);
          const slot18_00 = 36; // 18:00 = 36番目のスロット
          const slot19_00 = 38; // 19:00 = 38番目のスロット
          const absoluteSlot18 = dayStart77 + slot18_00;
          const absoluteSlot19 = dayStart77 + slot19_00;
          console.log(`7/7 18:00-19:00 (slots ${slot18_00}-${slot19_00} within day, absolute ${absoluteSlot18}-${absoluteSlot19}): "${dayView77.substring(slot18_00, slot19_00)}"`);
          console.log(`  Actual chars at absolute positions ${absoluteSlot18}-${absoluteSlot19}: "${schedule.availabilityView.substring(absoluteSlot18, absoluteSlot19)}"`);
          console.log(`  But slot 225 = '${schedule.availabilityView.charAt(225)}'`);
        }
        
        // 7/8の表示
        const targetDate = new Date('2025-07-08T00:00:00+09:00');
        const daysDiff = Math.floor((targetDate.getTime() - requestStart.getTime()) / (24 * 60 * 60 * 1000));
        
        if (daysDiff >= 0 && schedule.availabilityView.length > daysDiff * 48) {
          const dayStart = daysDiff * 48;
          const dayView = schedule.availabilityView.substring(dayStart, dayStart + 48);
          console.log(`\n7/8 availability (00:00-23:30): ${dayView}`);
          
          // 14:00-15:00を特定
          const slot14_00 = 28; // 14:00 = 28番目のスロット
          const slot15_00 = 30; // 15:00 = 30番目のスロット
          console.log(`7/8 14:00-15:00 (slots ${slot14_00}-${slot15_00}): "${dayView.substring(slot14_00, slot15_00)}"`);
        }
        
        // 7/9の表示
        const date79 = new Date('2025-07-09T00:00:00+09:00');
        const days79 = Math.floor((date79.getTime() - requestStart.getTime()) / (24 * 60 * 60 * 1000));
        if (days79 >= 0 && schedule.availabilityView.length > (days79 + 1) * 48) {
          const dayStart79 = days79 * 48;
          const dayView79 = schedule.availabilityView.substring(dayStart79, dayStart79 + 48);
          console.log(`\n7/9 availability (00:00-23:30): ${dayView79}`);
          const slot17_30 = 35; // 17:30 = 35番目のスロット
          const slot18_00 = 36; // 18:00 = 36番目のスロット
          console.log(`7/9 17:30-18:00 (slots ${slot17_30}-${slot18_00}): "${dayView79.substring(slot17_30, slot18_00)}"`);
        }
      }
    }
    
    return result;
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    const command = `mgc me events get --event-id "${eventId}" \
      --select "id,subject,start,end,location,responseStatus,attendees,organizer,isAllDay,isCancelled,showAs,responseRequested,body"`;
    const result = await this.executeCommand(command);
    return result;
  }

  async updateEvent(eventId: string, eventData: Partial<{
    subject: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    location?: { displayName: string };
    attendees?: Array<{ emailAddress: { address: string; name?: string } }>;
    body?: { contentType: string; content: string };
  }>): Promise<void> {
    const body = JSON.stringify(eventData);
    const command = `mgc me events patch --event-id "${eventId}" --body '${body}'`;
    await this.executeCommand(command);
  }

  async getUpcomingEvents(days: number = 7): Promise<CalendarEvent[]> {
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + days);
    
    // 日本時間の今日の始まりから取得
    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endDate = future.toISOString();
    
    const command = `mgc me calendar-view list \
      --headers 'Prefer=outlook.timezone="Asia/Tokyo"' \
      --select "id,subject,start,end,location,responseStatus,attendees,organizer,isAllDay,isCancelled,showAs,responseRequested" \
      --start-date-time "${startDate}" \
      --end-date-time "${endDate}" \
      --filter "isCancelled eq false" \
      --orderby "start/dateTime" \
      --top 100`;

    const result = await this.executeCommand(command);
    const events = result.value || [];
    
    // Declined予定を除外（件名がDeclined:で始まるものも除外）
    return events.filter((event: CalendarEvent) => 
      (!event.responseStatus || event.responseStatus.response !== 'declined') &&
      !event.subject.startsWith('Declined:')
    );
  }

  async declineEvent(eventId: string, comment?: string): Promise<void> {
    const body = comment 
      ? JSON.stringify({ comment, sendResponse: true })
      : JSON.stringify({ sendResponse: true });
    
    const command = `mgc users events decline post --user-id me --event-id "${eventId}" --body '${body}'`;
    await this.executeCommand(command);
  }

  async updateEventResponse(eventId: string, response: 'accept' | 'decline' | 'tentativelyAccept'): Promise<void> {
    // 通知を送らずにdecline/accept/tentativelyAcceptする
    const body = JSON.stringify({ sendResponse: false });
    
    let command: string;
    if (response === 'decline') {
      command = `mgc users events decline post --user-id me --event-id "${eventId}" --body '${body}'`;
    } else if (response === 'accept') {
      command = `mgc users events accept post --user-id me --event-id "${eventId}" --body '${body}'`;
    } else {
      command = `mgc users events tentatively-accept post --user-id me --event-id "${eventId}" --body '${body}'`;
    }
    
    await this.executeCommand(command);
  }

  async cancelEvent(eventId: string, comment?: string): Promise<void> {
    // イベントをキャンセルする（主催者のみ）
    const body = comment 
      ? JSON.stringify({ comment })
      : JSON.stringify({});
    
    const command = `mgc users events cancel post --user-id me --event-id "${eventId}" --body '${body}'`;
    await this.executeCommand(command);
  }
}