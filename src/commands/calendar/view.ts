import { MgcService } from '../../services/mgc.js';
import { getToday } from '../../utils/date.js';
import { formatEvent } from '../../utils/format.js';
import { selectUser } from '../../utils/interactive.js';
import chalk from 'chalk';

export async function viewCalendar(options: { date?: string; user?: string | boolean; json?: boolean } = {}): Promise<void> {
  const mgc = new MgcService();
  
  // 認証チェック
  const isAuthenticated = await mgc.checkAuth();
  if (!isAuthenticated) {
    console.error(chalk.red('Not authenticated. Please run: mgc auth'));
    process.exit(1);
  }

  // 日付範囲の設定（今日のみ）
  const { start, end } = getToday();
  
  try {
    // ユーザー指定の処理
    let userEmail: string | null = null;
    if (options.user === true) {
      // --userのみ指定された場合、インタラクティブ選択
      userEmail = await selectUser();
      if (!userEmail) {
        console.log(chalk.yellow('No user selected'));
        return;
      }
    } else if (typeof options.user === 'string') {
      // --user email@example.com のように直接指定
      userEmail = options.user;
    }

    console.log(chalk.blue('Fetching calendar events...'));
    if (userEmail) {
      console.log(chalk.gray(`User: ${userEmail}`));
      console.log(chalk.gray(`Date range: ${start} to ${end}`));
    }
    const events = userEmail 
      ? await mgc.getUserCalendarEvents(userEmail, start, end)
      : await mgc.getMyCalendarEvents(start, end);
    
    // JSON output for LLM integration
    if (options.json) {
      const output = {
        user: userEmail || 'self',
        date: new Date().toISOString().split('T')[0],
        totalEvents: events.length,
        events: events.map(event => ({
          id: event.id,
          subject: event.subject,
          start: event.start,
          end: event.end,
          location: event.location,
          isAllDay: event.isAllDay,
          attendees: event.attendees?.map(a => ({
            email: a.emailAddress.address,
            name: a.emailAddress.name,
            responseStatus: a.status?.response
          }))
        }))
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    
    if (events.length === 0) {
      console.log(chalk.gray('No events for today'));
      return;
    }
    
    const title = userEmail 
      ? `\nSchedule for ${userEmail}:`
      : '\nToday\'s Schedule:';
    console.log(chalk.bold(title));
    console.log(chalk.gray('─'.repeat(50)));
    
    events.forEach(event => {
      console.log(formatEvent(event));
    });
    
    console.log(chalk.gray('─'.repeat(50)));
    console.log(chalk.gray(`Total: ${events.length} events`));
  } catch (error: any) {
    if (error.message?.includes('ErrorAccessDenied')) {
      console.error(chalk.yellow('\n⚠️  Access denied to this user\'s calendar'));
      console.error(chalk.gray('You may need additional permissions to view this calendar.'));
      console.error(chalk.gray('Try asking the user to share their calendar with you.'));
    } else if (error.message?.includes('is not installed')) {
      console.error(chalk.red('\n❌ ' + error.message));
    } else {
      console.error(chalk.red('\n❌ Failed to fetch calendar events:'), error.message || error);
      if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
        console.error(chalk.gray('\nStack trace:'));
        console.error(chalk.gray(error.stack));
      }
    }
    process.exit(1);
  }
}