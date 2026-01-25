import 'package:flutter/material.dart';
import 'package:bandait/core/di/injection.dart';
import 'package:bandait/domain/repositories/session_repository.dart';

class PanicOverlay extends StatelessWidget {
  final Widget child;

  const PanicOverlay({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    // Stack the panic layer on top of child
    return Stack(
      children: [
        child,
        StreamBuilder<bool>(
          stream: getIt<SessionRepository>().panicStream,
          initialData: false,
          builder: (context, snapshot) {
            final isPanic = snapshot.data ?? false;

            if (!isPanic) return const SizedBox.shrink();

            return Container(
              color: Colors.red,
              width: double.infinity,
              height: double.infinity,
              child: const Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.warning_amber_rounded,
                    size: 120,
                    color: Colors.white,
                  ),
                  SizedBox(height: 24),
                  Text(
                    'PANIC STOP',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 48,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 4,
                    ),
                  ),
                  SizedBox(height: 16),
                  Text(
                    'WAIT FOR LEADER',
                    style: TextStyle(color: Colors.white, fontSize: 24),
                  ),
                ],
              ),
            );
          },
        ),
      ],
    );
  }
}
