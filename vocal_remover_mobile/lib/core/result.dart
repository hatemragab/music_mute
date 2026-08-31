/// Sealed result type for expressing success / failure without exceptions.
sealed class Result<T> {
  const Result();
}

/// Successful result carrying [value].
class Success<T> extends Result<T> {
  const Success(this.value);
  final T value;
}

/// Failed result carrying [error] and optional [stackTrace].
class Failure<T> extends Result<T> {
  const Failure(this.error, [this.stackTrace]);
  final Object error;
  final StackTrace? stackTrace;
}
