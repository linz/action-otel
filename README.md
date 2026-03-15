# linz/action-otel

Setup a `traceparent` at the start of a github workflow then submit it at the end of the workflow.

## Usage

As the first step in the github action run the open telementry workflow

```yaml
steps:
  - name: Setup Otel
    uses: linz/action-otel@master

  - name: Echo env
    runs: |
      echo $TRACEPARENT # traceparent is setup

    # Span gets submitted as a post workflow
```

## Configuration

To submit a span `OTEL_` configuration headers need to be present

```
OTEL_EXPORTER_OTLP_ENDPOINT: ${{ secrets.OTEL_EXPORTER_OTLP_ENDPOINT }}
OTEL_EXPORTER_OTLP_HEADERS: ${{ secrets.OTEL_EXPORTER_OTLP_HEADERS }}
```
