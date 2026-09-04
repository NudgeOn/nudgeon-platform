package channel

import (
	"context"
	"fmt"

	libqueue "github.com/nudgeon/nudgeon-platform/packages/libqueue-go"
)

// The same gate is used by the running push worker and generic send loop.
// A pending DLQ write yields retry=true, so neither a terminal log nor ACK is
// produced. An unavailable log sink also keeps otherwise completed work pending.
func processSendBatch(ctx context.Context, messages []libqueue.Message,
	handle func(context.Context, *libqueue.Message) ([]any, bool),
	flush func(context.Context, [][]any) error, ack func(context.Context, ...string) error) error {
	rows := make([][]any, 0, len(messages))
	ids := make([]string, 0, len(messages))
	for i := range messages {
		row, retry := handle(ctx, &messages[i])
		if row != nil {
			rows = append(rows, row)
		}
		if !retry {
			ids = append(ids, messages[i].StreamID)
		}
	}
	if err := flush(ctx, rows); err != nil {
		return fmt.Errorf("message_log flush: %w", err)
	}
	if err := ack(ctx, ids...); err != nil {
		return fmt.Errorf("queue ACK: %w", err)
	}
	return nil
}
