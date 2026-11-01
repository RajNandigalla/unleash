import { useEffect, useMemo, useRef, useState } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { foldGutter } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { Box, Button, Typography, alpha, styled } from '@mui/material';
import { sortJsonKeys } from 'utils/sortJsonKeys';

type JsonDiffViewerProps = {
    left?: unknown;
    right?: unknown;
    leftLabel: string;
    rightLabel: string;
    height?: number | string;
    defaultView?: 'changes' | 'full';
    showViewToggle?: boolean;
};

const StyledContainer = styled(Box)<{ height: number | string }>(
    ({ theme, height }) => ({
        height,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: theme.shape.borderRadiusMedium,
        overflow: 'auto',
        backgroundColor: theme.palette.background.paper,

        '& .cm-mergeView': {
            height: '100%',
            fontSize: theme.fontSizes.smallBody,
        },
        '& .cm-editor': {
            backgroundColor: theme.palette.background.paper,
            color: theme.palette.text.primary,
            outline: 0,
        },
        '& .cm-scroller': {
            fontFamily: theme.typography.fontFamily,
        },
        '& .cm-gutters': {
            backgroundColor: theme.palette.background.alternative,
            borderRight: `1px solid ${theme.palette.divider}`,
            color: theme.palette.text.secondary,
        },
        '& .cm-lineNumbers .cm-gutterElement': {
            paddingLeft: theme.spacing(0.75),
            paddingRight: theme.spacing(0.75),
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
        },
        '& .cm-foldGutter .cm-gutterElement': {
            paddingLeft: theme.spacing(0.5),
            paddingRight: theme.spacing(0.5),
            color: theme.palette.text.secondary,
        },
        '& .cm-changedLine': {
            backgroundColor: alpha(theme.palette.primary.main, 0.12),
        },
        '& .cm-changedLineGutter': {
            backgroundColor: alpha(theme.palette.primary.main, 0.2),
        },
        '& .cm-changedText': {
            backgroundColor: alpha(theme.palette.primary.main, 0.25),
            borderRadius: theme.shape.borderRadius,
        },
        '& .cm-insertedLine': {
            backgroundColor: alpha(theme.palette.success.main, 0.1),
        },
        '& .cm-deletedChunk, & .cm-deletedLine': {
            backgroundColor: alpha(theme.palette.error.main, 0.1),
        },
        '& .cm-deletedText': {
            backgroundColor: alpha(theme.palette.error.main, 0.25),
            borderRadius: theme.shape.borderRadius,
        },
        '& .cm-collapsedLines': {
            backgroundColor: theme.palette.background.alternative,
            color: theme.palette.text.secondary,
            fontSize: theme.fontSizes.smallerBody,
        },
        '& .cm-chunkButtons button': {
            color: theme.palette.primary.main,
        },
    }),
);

const StyledLabels = styled(Box)(({ theme }) => ({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(1),
}));

const StyledLabel = styled(Typography)(({ theme }) => ({
    fontWeight: theme.typography.fontWeightBold,
    fontSize: theme.fontSizes.smallerBody,
}));

export const JsonDiffViewer = ({
    left,
    right,
    leftLabel,
    rightLabel,
    height = 420,
    defaultView = 'changes',
    showViewToggle = true,
}: JsonDiffViewerProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [view, setView] = useState<'changes' | 'full'>(defaultView);

    const leftText = useMemo(
        () => JSON.stringify(sortJsonKeys(left ?? {}), undefined, 2),
        [left],
    );
    const rightText = useMemo(
        () => JSON.stringify(sortJsonKeys(right ?? {}), undefined, 2),
        [right],
    );

    useEffect(() => {
        if (!containerRef.current) {
            return;
        }

        const extensions = [
            json(),
            lineNumbers(),
            foldGutter(),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
        ];

        const mergeView = new MergeView({
            a: { doc: leftText, extensions },
            b: { doc: rightText, extensions },
            parent: containerRef.current,
            highlightChanges: true,
            gutter: true,
            ...(view === 'changes'
                ? { collapseUnchanged: { margin: 3, minSize: 4 } }
                : {}),
        });

        return () => mergeView.destroy();
    }, [leftText, rightText, view]);

    return (
        <Box>
            <Box
                sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    mb: 1,
                }}
            >
                <StyledLabels sx={{ flex: 1, mb: 0 }}>
                    <StyledLabel>{leftLabel}</StyledLabel>
                    <StyledLabel>{rightLabel}</StyledLabel>
                </StyledLabels>
                {showViewToggle && (
                    <Button
                        size='small'
                        onClick={() =>
                            setView(view === 'changes' ? 'full' : 'changes')
                        }
                    >
                        {view === 'changes'
                            ? 'Show full config'
                            : 'Changes only'}
                    </Button>
                )}
            </Box>
            <StyledContainer ref={containerRef} height={height} />
        </Box>
    );
};
